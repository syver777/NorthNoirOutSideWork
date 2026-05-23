import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const CHARS_PER_SECOND = 13.67; // Updated character reading speed

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

interface RequestBody {
  group_id: string;
  user_id: string;
  batch_number: number;
  total_batches: number;
  tab?: number;
}

interface ImagePromptTask {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  batch: Array<{ text: string; start: number; is_first_page: boolean }>;
  text_part: string;
  batch_output: string;
  total_batches: number;
  total_prompts: number;
  batch_number: number;
  status: string;
  progress: number;
  error: string | null;
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    firstPageFrequency: string;
    restFrequency: string;
    characters: Record<string, string>;
  };
  file_path: string;
  input_tokens: number;
  output_tokens: number;
  variant: number;
  is_corrected: boolean;
  description: string;
  version: number;
  video_process: boolean;
  language: string;
  model: string; // Add this field
  process_image: boolean; // Add this field
}

function cleanCurlyQuotes(text: string): string {
  return text
    .replace(/'/g, "'")  // Replace curly apostrophe with straight
    .replace(/'/g, "'")  // Replace another curly apostrophe variant
    .replace(/"/g, '"')  // Replace curly quotes with straight
    .replace(/"/g, '"') // Replace another curly quote variant
    // Additional Unicode quote normalization
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data?.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data?.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  if (typeof data?.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data?.total_batches !== 'number' || data.total_batches < 1) return 'Missing or invalid total_batches';
  // tab is optional, defaults to 1
  if (typeof data?.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

function validateSegments(segments: Array<{ text: string; start: number; is_first_page: boolean }>, textPartLength?: number): string | null {
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return 'Segments array is empty or invalid';
  }
  
  // Estimate word count from text part length if provided
  const estimatedWordCount = textPartLength ? Math.ceil(textPartLength / 5.5) : 1000;
  const minLength = estimatedWordCount < 1000 ? 10 : 30; // Reduced from 60 to 30
  const idealMinLength = estimatedWordCount < 1000 ? 30 : 60;
  
  const veryShortSegments = [];
  const shortSegments = [];
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    
    if (!segment.text || typeof segment.text !== 'string' || segment.text.trim().length === 0) {
      return `Invalid segment at start ${segment.start}: empty or non-string text`;
    }
    
    if (typeof segment.start !== 'number' || segment.start < 0) {
      return `Invalid segment at start ${segment.start}: invalid start position`;
    }
    
    if (typeof segment.is_first_page !== 'boolean') {
      return `Invalid segment at start ${segment.start}: is_first_page must be boolean`;
    }
    
    const segmentLength = segment.text.trim().length;
    
    // Track very short segments (less than absolute minimum)
    if (segmentLength < minLength) {
      veryShortSegments.push({ index: i, length: segmentLength, start: segment.start });
    } 
    // Track segments shorter than ideal but above absolute minimum
    else if (segmentLength < idealMinLength) {
      shortSegments.push({ index: i, length: segmentLength, start: segment.start });
    }
  }
  
  // Allow up to 10% very short segments for edge cases
  const maxVeryShortSegments = Math.max(1, Math.ceil(segments.length * 0.1));
  if (veryShortSegments.length > maxVeryShortSegments) {
    return `Too many very short segments: ${veryShortSegments.length} segments under ${minLength} characters (max allowed: ${maxVeryShortSegments})`;
  }
  
  // Allow up to 30% segments to be shorter than ideal length
  const maxShortSegments = Math.ceil(segments.length * 0.3);
  if (shortSegments.length > maxShortSegments) {
    console.warn(`Many short segments detected: ${shortSegments.length} segments under ${idealMinLength} characters, but within acceptable range`);
  }
  
  // Log warnings for monitoring
  if (veryShortSegments.length > 0) {
    console.warn(`Found ${veryShortSegments.length} very short segments:`, 
                 veryShortSegments.map(seg => ({ length: seg.length, start: seg.start })));
  }
  
  if (shortSegments.length > 0) {
    console.log(`Found ${shortSegments.length} segments shorter than ideal length (${idealMinLength} chars)`);
  }
  
  return null;
}

function validateSegmentLength(segments: Array<{ text: string; start: number; is_first_page: boolean }>, totalWordCount: number): boolean {
  const reconstructedText = segments.map(s => s.text).join(' ');
  const reconstructedWordCount = countWords(reconstructedText);
  const difference = Math.abs(reconstructedWordCount - totalWordCount);
  const percentDiff = (difference / totalWordCount) * 100;
  
  console.log(`Segment validation:`);
  console.log(`  Original word count: ${totalWordCount}`);
  console.log(`  Reconstructed word count: ${reconstructedWordCount}`);
  console.log(`  Difference: ${difference} words (${percentDiff.toFixed(2)}%)`);
  
  // Allow up to 10% difference (chapters may be removed)
  if (percentDiff > 10) {
    console.warn(`WARNING: Large word count difference detected`);
    return false;
  }
  
  return true;
}

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

function splitTextIntoNSegments(text: string, n: number): Array<{ text: string; start: number; is_first_page: boolean }> {
  if (n <= 0 || !text.trim()) {
    return [];
  }

  if (n === 1) {
    return [{ text: text.trim(), start: 0, is_first_page: false }];
  }

  const segments: Array<{ text: string; start: number; is_first_page: boolean }> = [];
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

function createCountBasedSegments(text: string, totalImages: number, firstPageImages: number | null = null): Array<{ text: string; start: number; is_first_page: boolean }> {
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
    const segments: Array<{ text: string; start: number; is_first_page: boolean }> = [];

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

function cleanTextForPrompts(text: string): string {
  // Strip SSML break tags (well-formed, malformed, and incomplete)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
 
  let firstChapterIdx = null;
  for (let i = 0; i < lines.length; i++) {
    if (chapterPattern.test(lines[i].trim())) {
      firstChapterIdx = i;
      break;
    }
  }
 
  let cleanedText = text;
  if (firstChapterIdx !== null) {
    const startIdx = firstChapterIdx + 1;
    const remainingLines = lines.slice(startIdx);
    cleanedText = remainingLines.join('\n');
  }
 
  // Clean curly quotes
  return cleanCurlyQuotes(cleanedText);
}

function detectChapterSections(text: string): Array<{text: string, startPos: number, endPos: number}> {
  const lines = text.split('\n');
  const chapterPattern = /^\*\*Chapter \d+.*\*\*$/;
  const chapterSections: Array<{text: string, startPos: number, endPos: number}> = [];
  
  let currentSection = '';
  let currentStartPos = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (chapterPattern.test(line.trim()) && currentSection.trim().length > 0) {
      // Found a new chapter, save the current section
      chapterSections.push({
        text: currentSection.trim(),
        startPos: currentStartPos,
        endPos: currentStartPos + currentSection.trim().length
      });
      currentSection = '';
      currentStartPos = lines.slice(0, i + 1).join('\n').length + 1;
    } else if (!chapterPattern.test(line.trim())) {
      // Add non-chapter lines to current section
      if (currentSection) currentSection += '\n';
      currentSection += line;
    }
  }
  
  // Add the last section if it exists
  if (currentSection.trim().length > 0) {
    chapterSections.push({
      text: currentSection.trim(),
      startPos: currentStartPos,
      endPos: currentStartPos + currentSection.trim().length
    });
  }
  
  // If no chapters found, treat entire text as one section
  if (chapterSections.length === 0) {
    chapterSections.push({
      text: text,
      startPos: 0,
      endPos: text.length
    });
  }
  
  console.log(`Detected ${chapterSections.length} chapter sections`);
  return chapterSections;
}

function segmentRemainingText(
  text: string, 
  startPos: number, 
  restSeconds: number, 
  globalStartPosition: number
): Array<{ text: string; start: number; is_first_page: boolean }> {
  const segments: Array<{ text: string; start: number; is_first_page: boolean }> = [];
  const charsPerPromptRest = Math.max(100, Math.round(restSeconds * CHARS_PER_SECOND));
  
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + charsPerPromptRest, text.length);
    
    // Try to find word boundary
    while (end < text.length && /[a-zA-Z0-9]/.test(text.slice(end - 1, end + 1))) {
      end -= 1;
    }
    if (end === pos) {
      end = pos + charsPerPromptRest;
    }
    
    let segmentText = text.slice(pos, end).trim();
    
    // Ensure minimum 60 characters for the last segment
    if (pos + segmentText.length >= text.length && segmentText.length < 60) {
      const startPosAdj = Math.max(0, text.length - 60);
      segmentText = text.slice(startPosAdj).trim();
      pos = text.length;
    }
    
    if (segmentText.length >= 60 || pos + segmentText.length >= text.length) {
      segments.push({
        text: segmentText,
        start: startPos + pos + globalStartPosition,
        is_first_page: false
      });
    }
    
    if (pos + segmentText.length >= text.length) {
      break;
    }
    pos = end;
  }
  
  return segments;
}

function segmentChapterSection(
  sectionText: string,
  sectionStartPos: number,
  firstPageSeconds: number,
  restSeconds: number,
  globalStartPosition: number = 0
): Array<{ text: string; start: number; is_first_page: boolean }> {
  const segments: Array<{ text: string; start: number; is_first_page: boolean }> = [];
  
  // Determine if this section contains the first page
  const sectionGlobalStart = globalStartPosition + sectionStartPos;
  const sectionGlobalEnd = sectionGlobalStart + sectionText.length;
  const containsFirstPage = sectionGlobalStart < 3000;
  
  if (containsFirstPage && sectionGlobalStart === 0) {
    // This section starts at the beginning and contains first page
    const firstPagePortion = sectionText.slice(0, Math.min(3000 - sectionGlobalStart, sectionText.length));
    const charsPerPrompt = Math.max(100, Math.min(3000, Math.round(firstPageSeconds * CHARS_PER_SECOND)));
    
    // Segment first page portion
    let pos = 0;
    while (pos < firstPagePortion.length) {
      let end = Math.min(pos + charsPerPrompt, firstPagePortion.length);
      
      // Try to find word boundary
      while (end < firstPagePortion.length && /[a-zA-Z0-9]/.test(firstPagePortion.slice(end - 1, end + 1))) {
        end -= 1;
      }
      if (end === pos) {
        end = pos + charsPerPrompt;
      }
      
      let segmentText = firstPagePortion.slice(pos, end).trim();
      
      // Ensure minimum 60 characters
      if (segmentText.length < 60 && pos + 60 <= firstPagePortion.length) {
        end = pos + 60;
        while (end < firstPagePortion.length && /[a-zA-Z0-9]/.test(firstPagePortion.slice(end - 1, end + 1))) {
          end += 1;
        }
        segmentText = firstPagePortion.slice(pos, end).trim();
      }
      
      if (segmentText.length >= 60 || pos + segmentText.length >= firstPagePortion.length) {
        segments.push({
          text: segmentText,
          start: sectionStartPos + pos + globalStartPosition,
          is_first_page: true
        });
      }
      
      pos = end;
    }
    
    // Handle remaining portion of this section after first page
    if (sectionGlobalEnd > 3000) {
      const remainingStart = 3000 - sectionGlobalStart;
      const remainingText = sectionText.slice(remainingStart);
      if (remainingText && restSeconds > 0) {
        const remainingSegments = segmentRemainingText(
          remainingText,
          sectionStartPos + remainingStart,
          restSeconds,
          globalStartPosition
        );
        segments.push(...remainingSegments);
      }
    }
  } else if (sectionGlobalStart < 3000 && 3000 < sectionGlobalEnd) {
    // This section spans across the 3000 character boundary
    const firstPagePortion = sectionText.slice(0, 3000 - sectionGlobalStart);
    const remainingPortion = sectionText.slice(3000 - sectionGlobalStart);
    
    // Handle first page portion
    if (firstPagePortion) {
      const charsPerPrompt = Math.max(100, Math.min(3000, Math.round(firstPageSeconds * CHARS_PER_SECOND)));
      let pos = 0;
      while (pos < firstPagePortion.length) {
        let end = Math.min(pos + charsPerPrompt, firstPagePortion.length);
        
        // Try to find word boundary
        while (end < firstPagePortion.length && /[a-zA-Z0-9]/.test(firstPagePortion.slice(end - 1, end + 1))) {
          end -= 1;
        }
        if (end === pos) {
          end = pos + charsPerPrompt;
        }
        
        let segmentText = firstPagePortion.slice(pos, end).trim();
        
        // Ensure minimum 60 characters
        if (segmentText.length < 60 && pos + 60 <= firstPagePortion.length) {
          end = pos + 60;
          while (end < firstPagePortion.length && /[a-zA-Z0-9]/.test(firstPagePortion.slice(end - 1, end + 1))) {
            end += 1;
          }
          segmentText = firstPagePortion.slice(pos, end).trim();
        }
        
        if (segmentText.length >= 60 || pos + segmentText.length >= firstPagePortion.length) {
          segments.push({
            text: segmentText,
            start: sectionStartPos + pos + globalStartPosition,
            is_first_page: true
          });
        }
        
        pos = end;
      }
    }
    
    // Handle remaining portion
    if (remainingPortion && restSeconds > 0) {
      const remainingSegments = segmentRemainingText(
        remainingPortion,
        sectionStartPos + firstPagePortion.length,
        restSeconds,
        globalStartPosition
      );
      segments.push(...remainingSegments);
    }
  } else {
    // This entire section is after the first page
    if (restSeconds > 0) {
      const remainingSegments = segmentRemainingText(
        sectionText,
        sectionStartPos,
        restSeconds,
        globalStartPosition
      );
      segments.push(...remainingSegments);
    }
  }
  
  return segments;
}

function segmentText(text: string, firstPageSeconds: number, restSeconds: number, startPosition: number = 0): Array<{ text: string; start: number; is_first_page: boolean }> {
  const cleanedText = cleanTextForPrompts(text);
  
  // Calculate total images based on story characteristics (matching Python logic)
  const wordCount = countWords(cleanedText);
  const charCount = cleanedText.length;
  
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
  
  console.log(`Count-based segmentation calculation:`);
  console.log(`  Word count: ${wordCount}, Char count: ${charCount}`);
  console.log(`  Estimated runtime: ${Math.floor(estimatedRuntime)}s`);
  console.log(`  First page: ${firstPageImages} images (${Math.floor(firstPageRuntime)}s / ${firstPageSeconds}s)`);
  console.log(`  Rest: ${restImages} images (${Math.floor(restRuntime)}s / ${restSeconds}s)`);
  console.log(`  Total images: ${totalImages}`);
  
  // Use count-based segmentation to create exactly the calculated number of segments
  const segments = createCountBasedSegments(cleanedText, totalImages, firstPageImages);
  
  console.log(`Created ${segments.length} segments (${segments.filter(s => s.is_first_page).length} first page, ${segments.filter(s => !s.is_first_page).length} rest)`);
  
  return segments;
}

async function resetStuckTasks(groupId: string, userId: string, tab: number = 1, variant: number = 1): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      console.log(`Checking for stuck tasks for group ${groupId}, tab ${tab}, variant ${variant}, attempt ${attempt + 1}`);
      const { data: stuckTasks, error: stuckError } = await supabase
        .from('image_prompt_tasks')
        .select('id, updated_at, batch_number')
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('status', 'running');

      if (stuckError) {
        throw new Error(`Failed to check stuck tasks: ${stuckError.message}`);
      }
      return;
    } catch (error: any) {
      console.error(`Error resetting stuck tasks, attempt ${attempt + 1}: ${error.message}`);
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        await logError('Failed to reset stuck tasks after 3 attempts', error);
        throw error;
      }
    }
  }
}

async function triggerNextVideoStep(userId: string, groupId: string, step: 'image_generation', variant: number, tab: number = 1): Promise<void> {
  try {
    console.log(`Image prompts completed for video task, triggering image generation for tab ${tab} with variant ${variant}`);
  
    // Update video task status
    await supabase
      .from('video_tasks')
      .update({
        image_prompt_status: 'completed',
        image_prompt_progress: 100,
        image_generation_status: 'running',
        overall_progress: 50,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);

    // Get video task settings
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .single();

    if (!videoTask) {
      throw new Error('Video task not found');
    }

    // Get the completed image prompt document
    const { data: imagePromptDoc } = await supabase
      .from('story_documents')
      .select('*')
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('is_prompted', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!imagePromptDoc) {
      throw new Error('Image prompt document not found');
    }

    // Map image model - support both direct model names and legacy tier names
    const modelMapping = {
      'standard': 'imagen-4-fast',
      'plus': 'gpt-image-1-mini',
      'premium': 'imagen-4-ultra',
      'spark': 'flux-2-dev',
      'grok': 'grok-imagine-image',
      'prime': 'seedream-4.5',
      'genesis': 'nano-banana-pro'
    };

    const supportedModels = ['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'];

    // If image_model is already a supported model, use it directly; otherwise map it
    const imageGenerationModel = supportedModels.includes(videoTask.image_model) 
      ? videoTask.image_model 
      : modelMapping[videoTask.image_model as keyof typeof modelMapping] || 'imagen-4-fast';

    // Trigger image generation
    const response = await fetch(`${supabaseUrl}/functions/v1/setup-image-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        group_id: groupId,
        file_path: imagePromptDoc.file_path,
        story_title: videoTask.story_title,
        description: videoTask.description,
        doc_id: imagePromptDoc.id,
        variant: variant,
        image_model: imageGenerationModel,
        videoProcess: true,
        language: imagePromptDoc.language || 'english',
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to trigger image generation: ${response.status}`);
    }

    console.log(`Successfully triggered image generation for video task ${videoTask.id}`);
  } catch (error: any) {
    console.error(`Error triggering image generation: ${error.message}`);
    await logError('Error triggering image generation for video', error);
  
    await supabase
      .from('video_tasks')
      .update({
        image_prompt_status: 'error',
        overall_status: 'error',
        error_message: `Failed to trigger image generation: ${error.message}`,
        updated_at: new Date().toISOString()
      })
      .eq('group_id', groupId)
      .eq('user_id', userId);
  }
}

async function triggerImageGeneration(
  userId: string, 
  groupId: string, 
  documentId: string, 
  title: string, 
  description: string, 
  variant: number, 
  imageModel: string, 
  language: string,
  tab: number = 1
): Promise<void> {
  try {
    console.log(`Image prompts completed, triggering automatic image generation for tab ${tab}`);

    // Get the completed image prompt document
    const { data: imagePromptDoc, error: docError } = await supabase
      .from('story_documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !imagePromptDoc) {
      throw new Error('Image prompt document not found');
    }

    // Map image prompt model to image generation model
    const modelMapping = {
      'standard': 'imagen-4-fast',
      'plus': 'gpt-image-1-mini',
      'premium': 'imagen-4-ultra',
      'spark': 'flux-2-dev',
      'grok': 'grok-imagine-image',
      'prime': 'seedream-4.5',
      'genesis': 'nano-banana-pro'
    };

    const supportedModels = ['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'];

    // If imageModel is already a supported model, use it directly; otherwise map it
    const imageGenerationModel = supportedModels.includes(imageModel) 
      ? imageModel 
      : modelMapping[imageModel as keyof typeof modelMapping] || 'imagen-4-fast';

    // Trigger image generation
    const response = await fetch(`${supabaseUrl}/functions/v1/setup-image-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        user_id: userId,
        group_id: groupId,
        file_path: imagePromptDoc.file_path,
        story_title: title,
        description: description,
        doc_id: documentId,
        variant: variant,
        image_model: imageGenerationModel,
        videoProcess: false, // This is not a video process
        language: language,
        tab: tab
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to trigger image generation: ${response.status}`);
    }

    console.log(`Successfully triggered automatic image generation for document ${documentId}`);
  } catch (error: any) {
    console.error(`Error triggering automatic image generation: ${error.message}`);
    await logError('Error triggering automatic image generation', error);
  }
}

// ← UPDATED: Added processImage and tab parameters
async function compileFinalDocument(userId: string, groupId: string, title: string, description: string, variant: number, isCorrected: boolean, version: number, imageModel: 'standard' | 'plus' | 'premium' | 'spark' | 'prime' | 'genesis', language: string, model: string, processImage: boolean, tab: number = 1) {
  try {
    console.log(`Compiling final document for group ${groupId}, tab ${tab} with title: ${title}, language: ${language}, model: ${model}, processImage: ${processImage}`);
    const { data, error } = await supabase
      .from('image_prompt_tasks')
      .select('batch_output, batch, batch_number, version, story_title, description, variant, is_corrected, image_model, video_process, language, model, process_image')
      .eq('user_id', userId)
      .eq('group_id', groupId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0)
      .order('batch_number', { ascending: true });

    if (error || !data || data.length === 0) throw new Error(`Failed to fetch tasks: ${error?.message || 'No data'}`);

    // Start with empty content (no title header) to match Python implementation
    let fullContent = '';
    data.forEach(task => {
      if (task.batch_output) {
        fullContent += `${task.batch_output.trim()}\n\n`;
      }
    });

    if (!fullContent.trim() || fullContent.length < 50) {
      throw new Error('Compiled document content is empty or too short');
    }

    console.log(`Compiled final document, length: ${fullContent.length} characters`);
    const sanitizedTitle = title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalFilePath = `documents/${userId}/${groupId}/image-prompts-${sanitizedTitle}_${timestamp}.txt`;

    console.log(`Generated final file path: ${finalFilePath}`);
    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(finalFilePath, new TextEncoder().encode(fullContent), { contentType: 'text/plain' });

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);
    console.log(`Uploaded final document to ${finalFilePath}`);

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(finalFilePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');

    const wordCount = countWords(fullContent);
    const documentId = crypto.randomUUID();
    const { error: docError } = await supabase
      .from('story_documents')
      .insert({
        id: documentId,
        title: `Image Prompt: ${title}`,
        description,
        word_count: wordCount,
        version,
        is_corrected: isCorrected,
        is_prompted: true,
        user_id: userId,
        file_path: finalFilePath,
        file_url: urlData.publicUrl,
        created_at: new Date().toISOString(),
        group_id: groupId,
        variant,
        image_model: imageModel,
        language: language,
        model: model, // Add model to document
        tab: tab
      });

    if (docError) throw new Error(`Failed to save document: ${docError.message}`);
    console.log(`Saved document for Image Prompt: ${title}, ID: ${documentId}, language: ${language}, model: ${model}`);

    const { error: updateError } = await supabase
      .from('image_prompt_tasks')
      .update({ 
        status: 'completed_final',
        image_prompt_document_id: documentId, // Track document ID in task
        updated_at: new Date().toISOString() 
      })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);

    if (updateError) throw new Error(`Failed to update tasks to completed_final: ${updateError.message}`);
    console.log(`Marked all tasks as completed_final for group ${groupId}, tab ${tab}`);

    // Check if this is part of a video process OR if process_image is enabled
    const isVideoProcess = data.some(task => task.video_process === true);
    const shouldProcessImages = processImage || isVideoProcess;
    
    if (shouldProcessImages) {
      if (isVideoProcess) {
        // Update video_tasks with image_prompt_document_id
        await supabase
          .from('video_tasks')
          .update({ 
            image_prompt_document_id: documentId,
            updated_at: new Date().toISOString()
          })
          .eq('group_id', groupId)
          .eq('user_id', userId);
        
        console.log(`Updated video_tasks with image_prompt_document_id: ${documentId}`);
        
        // This is part of a video process, trigger image generation with variant from image_prompt_tasks
        await triggerNextVideoStep(userId, groupId, 'image_generation', variant, tab);
      } else if (processImage) {
        // This is regular image prompt with auto image generation
        await triggerImageGeneration(userId, groupId, documentId, title, description, variant, imageModel, language, tab);
      }
    }
  } catch (error: any) {
    console.error(`Error compiling final document: ${error.message}`);
    await logError('Error compiling final document', error);
    await supabase
      .from('image_prompt_tasks')
      .update({ status: 'error', error: `Failed to compile document: ${error.message}`, updated_at: new Date().toISOString() })
      .eq('group_id', groupId)
      .eq('user_id', userId)
      .eq('tab', tab)
      .eq('variant', variant)
      .gt('batch_number', 0);
    throw error;
  }
}

function isRetryableError(error: any): boolean {
  const errorMsg = error.message || error.toString() || '';
  return errorMsg.includes('520') || 
         errorMsg.includes('500') || 
         errorMsg.includes('502') ||
         errorMsg.includes('503') ||
         errorMsg.includes('504') ||
         errorMsg.includes('connection') ||
         errorMsg.includes('timeout') ||
         errorMsg.includes('Failed to download document') ||
         errorMsg.includes('Failed to trigger batch');
}

// Detects ReferenceError / "X is not defined" style code bugs. When these
// occur we silently mark the task as 'running' (with no `error` column) so
// the stuck-task retry system can pick it up without surfacing a hard error.
function isSilentError(error: any): boolean {
  const msg = error?.message || error?.toString() || '';
  const name = error?.name || '';
  return name === 'ReferenceError' || msg.includes('is not defined');
}

function buildErrorUpdate(error: any, prefix: string): Record<string, any> {
  const silent = isSilentError(error);
  const status = silent || isRetryableError(error) ? 'running' : 'pending';
  return {
    status,
    error: silent ? null : `${prefix}: ${error.message}`,
    updated_at: new Date().toISOString(),
  };
}

async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number, tab: number = 1, variant: number = 1) {
  const retryDelays = [5000, 10000, 20000];
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await resetStuckTasks(groupId, userId, tab);
      if (currentBatchNumber >= totalBatches) {
        console.log(`No more batches to trigger for group ${groupId}, tab ${tab}. Checking completion status.`);
        const { data: tasks, error: tasksError } = await supabase
          .from('image_prompt_tasks')
          .select('story_title, description, variant, is_corrected, status, version, image_model, video_process, language, model, process_image')
          .eq('group_id', groupId)
          .eq('user_id', userId)
          .eq('tab', tab)
          .gt('batch_number', 0)
          .order('batch_number', { ascending: true });

        if (tasksError || !tasks || tasks.length === 0) {
          const errorMsg = `No tasks found for group ${groupId}, tab ${tab}. Cannot compile final document.`;
          console.error(errorMsg);
          await logError(errorMsg, new Error('Tasks not found'));
          await supabase
            .from('image_prompt_tasks')
            .update({ status: 'error', error: errorMsg, updated_at: new Date().toISOString() })
            .eq('group_id', groupId)
            .eq('user_id', userId)
            .eq('tab', tab)
            .gt('batch_number', 0);
          throw new Error(errorMsg);
        }

        const completedTasks = tasks.filter(task => task.status === 'completed' || task.status === 'completed_final').length;
        if (completedTasks < totalBatches) {
          const errorMsg = `Not all batches completed: ${completedTasks}/${totalBatches}`;
          console.error(errorMsg);
          await logError(errorMsg, new Error('Incomplete batches'));
          throw new Error(errorMsg);
        }

        const task = tasks.find(t => t.story_title && t.description);
        if (!task) {
          const errorMsg = `No task with valid story_title and description found for group ${groupId}`;
          console.error(errorMsg);
          await logError(errorMsg, new Error('Invalid task metadata'));
          throw new Error(errorMsg);
        }

        await compileFinalDocument(userId, groupId, task.story_title, task.description, task.variant, task.is_corrected, task.version, task.image_model, task.language || 'english', task.model || 'sonnet', task.process_image || false, tab);
        return;
      }

      const nextBatchNumber = currentBatchNumber + 1;
      console.log(`Triggering trigger-image-next-batch for batch ${nextBatchNumber} for group ${groupId}, tab ${tab}, variant ${variant}`);
      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-image-next-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          group_id: groupId,
          user_id: userId,
          current_batch_number: currentBatchNumber,
          tab: tab,
          variant: variant
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to trigger batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
      }
      console.log(`Successfully triggered batch ${nextBatchNumber}`);
      return;
    } catch (error: any) {
      console.error(`Error in triggerNextBatch for batch ${currentBatchNumber + 1}: ${error.message}`);
      if (attempt < retryDelays.length && (error.message.includes('409') || error.message.includes('running'))) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      await logError(`Error triggering batch ${currentBatchNumber + 1}`, error);

      await supabase
        .from('image_prompt_tasks')
        .update(buildErrorUpdate(error, 'Failed to trigger batch'))
        .eq('group_id', groupId)
        .eq('user_id', userId)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('batch_number', currentBatchNumber + 1);
      throw error;
    }
  }
  throw new Error(`Failed to trigger next batch after ${retryDelays.length + 1} attempts`);
}

async function callGenerateImagePrompts(payload: any, taskId: string, batchNumber: number): Promise<any> {
  const retryDelays = [10000, 20000, 40000, 80000, 160000, 320000];
  const maxRetries = retryDelays.length;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Calling generate-image-prompts for batch ${batchNumber}, attempt ${attempt + 1}, payload size: ${JSON.stringify(payload).length} bytes`);
      console.log(`Payload excerpt: ${JSON.stringify(payload).slice(0, 200)}...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        console.log(`Request for batch ${batchNumber} aborted due to timeout after 390 seconds`);
      }, 390000); // 390 seconds timeout

      let response;
      try {
        response = await fetch(`${supabaseUrl}/functions/v1/generate-image-prompts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': supabaseServiceRoleKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error: any) {
        if (error.name === 'AbortError') {
          throw new Error('Request timed out after 390 seconds');
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorText = await response.text();
        const errorMsg = `HTTP ${response.status}: ${errorText.slice(0, 200)}...`;
        console.error(`Error response for batch ${batchNumber}: ${errorMsg}`);
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < maxRetries) {
          console.log(`Received ${response.status} for batch ${batchNumber}, retrying after ${retryDelays[attempt] / 1000}s`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(errorMsg);
      }

      const result = await response.json();
      console.log(`Received response for batch ${batchNumber}: ${JSON.stringify(result).slice(0, 200)}...`);
      if (!result.results || !Array.isArray(result.results)) {
        throw new Error('Invalid response format: Missing or invalid results array');
      }
      console.log(`Generated prompts for batch ${batchNumber}, results count: ${result.results.length}`);
      return result;
    } catch (error: any) {
      console.error(`Error in generate-image-prompts for batch ${batchNumber}, attempt ${attempt + 1}: ${error.message}`);
      if (attempt < maxRetries && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.message.includes('520') || error.message.includes('overloaded') || error.message.includes('timeout') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      
      await supabase
        .from('image_prompt_tasks')
        .update(buildErrorUpdate(error, 'Failed to generate prompts'))
        .eq('id', taskId);
      throw error;
    }
  }
  throw new Error(`Failed to generate prompts after ${maxRetries + 1} attempts`);
}

async function processImagePromptTask(task: ImagePromptTask, group_id: string, user_id: string, batch_number: number, total_batches: number, tab: number = 1, variant: number = 1) {
  try {
    // Check if image processing is enabled for this video task
    const { data: videoTask } = await supabase
      .from('video_tasks')
      .select('process_images')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .single();

    if (videoTask && videoTask.process_images === false) {
      console.log(`Image processing disabled for group ${group_id}, returning empty response`);
      await supabase
        .from('image_prompt_tasks')
        .update({
          status: 'completed',
          batch_output: 'Image processing disabled',
          progress: 100,
          input_tokens: 0,
          output_tokens: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', task.id)
        .eq('variant', variant);
      
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return { content: 'Image processing disabled', input_tokens: 0, output_tokens: 0, batch_number, skipped: true };
    }

    if (task.status === 'completed' || task.status === 'completed_final') {
      console.log(`Batch ${batch_number} already completed, triggering next batch`);
      await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);
      return { content: task.batch_output || '', input_tokens: task.input_tokens || 0, output_tokens: task.output_tokens || 0, batch_number };
    }

    if (task.status !== 'queued') {
      console.log(`Updating batch ${batch_number} to queued, task ID: ${task.id}`);
      const { error: statusError } = await supabase
        .from('image_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString(), error: null })
        .eq('id', task.id)
        .eq('variant', variant);
      if (statusError) {
        const errorMsg = `Failed to update task ${task.id} to queued: ${statusError.message}`;
        await logError(errorMsg, statusError);
        throw new Error(errorMsg);
      }
    }

    console.log(`Updating batch ${batch_number} to running, task ID: ${task.id}`);
    const { error: statusError } = await supabase
      .from('image_prompt_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('variant', variant);
    if (statusError) {
      const errorMsg = `Failed to update task ${task.id} to running: ${statusError.message}`;
      await logError(errorMsg, statusError);
      throw new Error(errorMsg);
    }

    console.log(`Downloading document from ${task.file_path}`);
    let fileData, content;
    
    try {
      const downloadResult = await supabase
        .storage
        .from('stories')
        .download(task.file_path);
      
      if (downloadResult.error) {
        throw downloadResult.error;
      }
      
      fileData = downloadResult.data;
      const arrayBuffer = await fileData.arrayBuffer();
      content = new TextDecoder().decode(arrayBuffer);
    } catch (fileError: any) {
      console.error(`Failed to download document: ${fileError.message}`);
      // Set to 'running' for retryable download errors
      await supabase
        .from('image_prompt_tasks')
        .update({ status: 'running', error: `Failed to download document: ${fileError.message}`, updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('variant', variant);
      throw new Error(`Failed to download document: ${fileError.message}`);
    }

    if (!content || content.length === 0) {
      await supabase
        .from('image_prompt_tasks')
        .update({ status: 'running', error: 'Document content is empty', updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('variant', variant);
      throw new Error('Document content is empty');
    }

    console.log(`Downloaded document, length: ${content.length} characters, words: ${countWords(content)}`);

    // text_part should remain as the part number reference - do not overwrite it
    console.log(`Using text_part as reference: "${task.text_part}"`);

    // Final validation before calling generate-image-prompts
    if (!task.text_part || task.text_part.trim().length === 0) {
      const errorMsg = `text_part is empty after validation for batch ${batch_number}`;
      await supabase
        .from('image_prompt_tasks')
        .update({ status: 'running', error: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', task.id);
      throw new Error(errorMsg);
    }

    console.log(`Validating ${task.batch.length} segments for batch ${batch_number}`);
    const segmentValidationError = validateSegments(task.batch, task.text_part?.length);
    if (segmentValidationError) {
      await supabase
        .from('image_prompt_tasks')
        .update({ status: 'running', error: segmentValidationError, updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('variant', variant);
      throw new Error(segmentValidationError);
    }

    const maxRuntime = Math.min(task.batch.length * 390000, 1800000); // 390s per segment, max 30 minutes
    let results: any[] = []; // Support both V1 and V2 formats
    let input_tokens = 0;
    let output_tokens = 0;
    const segmentsPerCall = 1;

    for (let i = 0; i < task.batch.length; i += segmentsPerCall) {
      if (Date.now() - startTime > maxRuntime) {
        const errorMsg = `Processing timed out for batch ${batch_number} after ${maxRuntime / 1000} seconds`;
        await supabase
          .from('image_prompt_tasks')
          .update({ status: 'running', error: errorMsg, updated_at: new Date().toISOString() })
          .eq('id', task.id)
          .eq('variant', variant);
        throw new Error(errorMsg);
      }

      const chunk = task.batch.slice(i, i + segmentsPerCall);
      console.log(`Processing segments ${i + 1} to ${i + chunk.length} of ${task.batch.length} for batch ${batch_number}`);
      const payload = {
        batch_segments: chunk,
        text_part: task.text_part,
        settings: task.settings,
        use_character_descriptions: task.settings.useCharacterDescriptions,
        characters: task.settings.characters,
        language: task.language || 'english',
        model: task.model || 'sonnet', // Pass model to generate-image-prompts
        task_id: task.id, // V2: Pass task_id for format version detection
        group_id: task.group_id, // V2: Pass group_id for context fetching
      };

      const chunkResult = await callGenerateImagePrompts(payload, task.id, batch_number);
      results = results.concat(chunkResult.results);
      input_tokens += chunkResult.input_tokens || 0;
      output_tokens += chunkResult.output_tokens || 0;
    }

    console.log(`Combining ${results.length} results for batch ${batch_number}`);
    
    // Build batch content using text + prompt format
    let batchContent = '';
    results.forEach((item: { text: string; prompt: string }) => {
      batchContent += `[${item.text}]\n[Image Prompt: ${item.prompt}]\n\n`;
    });

    if (!batchContent.trim()) {
      const errorMsg = `No content generated for batch ${batch_number}`;
      await supabase
        .from('image_prompt_tasks')
        .update({ status: 'running', error: errorMsg, updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .eq('variant', variant);
      throw new Error(errorMsg);
    }

    console.log(`Updating task ${task.id} to completed for batch ${batch_number}`);
    await supabase
      .from('image_prompt_tasks')
      .update({
        status: 'completed',
        batch_output: batchContent,
        progress: 100,
        input_tokens: input_tokens,
        output_tokens: output_tokens,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id)
      .eq('variant', variant);

    console.log(`Batch ${batch_number} processing completed, triggering next batch`);
    await triggerNextBatch(group_id, user_id, batch_number, total_batches, tab, variant);

    return { content: batchContent, input_tokens, output_tokens, batch_number };
  } catch (error: any) {
    console.error(`Error in processImagePromptTask for batch ${batch_number}: ${error.message}`);
    await logError('Error in process-image-batch task', error);

    await supabase
      .from('image_prompt_tasks')
      .update(buildErrorUpdate(error, 'Processing failed'))
      .eq('id', task.id)
      .eq('variant', variant);
    throw error;
  }
}

const startTime = Date.now();
const maxRuntime = 400000; // 400 seconds
const idleTimeout = 140000; // 140 seconds to ensure response within 150s idle timeout

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const responseSent = { value: false }; // Track if response has been sent

  try {
    if (req.method === 'OPTIONS') {
      responseSent.value = true;
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });
    }

    let payload: RequestBody;
    try {
      payload = await req.json();
    } catch (error) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }

    const validationError = validateInputs(payload);
    if (validationError) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { group_id, user_id, batch_number, total_batches, tab = 1, variant = 1 } = payload;
    console.log(`Starting process-image-batch for batch ${batch_number}, group ${group_id}, tab ${tab}, variant ${variant}`);

    await resetStuckTasks(group_id, user_id, tab, variant);

    let task: ImagePromptTask | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error: taskError } = await supabase
        .from('image_prompt_tasks')
        .select('*')
        .eq('group_id', group_id)
        .eq('user_id', user_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('batch_number', batch_number)
        .single();

      if (taskError || !data) {
        console.error(`Task query failed (attempt ${attempt + 1}): ${taskError?.message || 'No task found'}`);
        await logError(`Task query failed (attempt ${attempt + 1})`, taskError || new Error('No task found'));
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        responseSent.value = true;
        return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
      }

      task = data;
      console.log(`Task found: ID ${task.id}, batch ${batch_number}, language: ${task.language || 'english'}, model: ${task.model || 'sonnet'}, processImage: ${task.process_image || false}`);
      break;
    }

    if (!task) {
      const errorMsg = `Task not found for group ${group_id}, user ${user_id}, batch ${batch_number}, tab ${tab} after 3 attempts`;
      await logError('Task not found', new Error(errorMsg));
      responseSent.value = true;
      return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    // Start background processing
    const processPromise = processImagePromptTask(task, group_id, user_id, batch_number, total_batches, tab, variant).catch(async (error) => {
      console.error(`Background processing failed for batch ${batch_number}: ${error.message}`);
      await logError('Background processing failed', error);
      if (!responseSent.value) {
        responseSent.value = true;
        return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
      }
    });

    // Set a timeout to update task status to 'running' just before idle timeout
    setTimeout(async () => {
      if (!responseSent.value && Date.now() - startTime > idleTimeout - 5000) {
        console.log(`Approaching idle timeout, updating task ${task!.id} to running`);
        await supabase
          .from('image_prompt_tasks')
          .update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', task!.id)
          .eq('variant', variant);
      }
    }, idleTimeout - 5000);

    // Wait up to 140s for quick completion
    const quickResult = await Promise.race([
      processPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), idleTimeout)),
    ]);

    if (quickResult) {
      responseSent.value = true;
      const elapsed = Date.now() - startTime;
      if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
      return new Response(JSON.stringify(quickResult), { status: 200, headers: responseHeaders });
    }

    // If not completed within 140s, send 202 Accepted and let background task continue
    console.log(`Sending 202 Accepted for batch ${batch_number}, processing continues in background`);
    responseSent.value = true;
    return new Response(
      JSON.stringify({ message: 'Processing started, results will be available in image_prompt_tasks', batch_number }),
      { status: 202, headers: responseHeaders }
    );
  } catch (error: any) {
    console.error(`Error in process-image-batch for batch ${payload?.batch_number || 'unknown'}: ${error.message}`);
    await logError('Error in process-image-batch', error);

    await supabase
      .from('image_prompt_tasks')
      .update(buildErrorUpdate(error, 'Processing failed'))
      .eq('group_id', payload?.group_id)
      .eq('user_id', payload?.user_id)
      .eq('tab', payload?.tab || 1)
      .eq('variant', payload?.variant || 1)
      .eq('batch_number', payload?.batch_number);
    if (!responseSent.value) {
      responseSent.value = true;
      return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
    }
    throw error; // Ensure error is logged but not sent if response was already sent
  }
});



