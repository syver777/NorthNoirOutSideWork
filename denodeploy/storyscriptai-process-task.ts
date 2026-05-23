
import { createClient } from 'jsr:@supabase/supabase-js@^2';

interface Segment {
  text: string;
  start: number;
  is_first_page: boolean;
}

interface Task {
  id: string;
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;
  batch: Segment[];
  text_part: string;
  batch_output: string;
  total_batches: number;
  batch_number: number;
  total_prompts: number;
  status: string;
  progress: number;
  error: null | string;
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    firstPageFrequency: string;
    restFrequency: string;
    characters: Record<string, string>;
  };
  variant: number;
  doc_id: string;
  file_path: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
  version: number;
  image_model: string;
  video_process: boolean;
  language: string;
  model: string;
  process_image: boolean;
  tab: number; // Add tab field
}

interface JobRequest {
  jobId: string;
  user_id: string;
}

const TOKEN_PER_WORD = 1.33;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const MAX_TEXT_PART_CHARS = 56000; // ~8000 words
const MIN_TEXT_PART_LENGTH = 100;
const CHARS_PER_SECOND = 13.67; // Updated character reading speed

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SECRET_KEY") || ""
);

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

function calculateWordCount(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

function estimateTokens(text: string): number {
  return Math.ceil(calculateWordCount(text) * TOKEN_PER_WORD);
}

function splitTextIfLarge(text: string): string[] {
  if (text.length <= MAX_TEXT_PART_CHARS) {
    // Skip very small parts
    if (text.length < MIN_TEXT_PART_LENGTH) {
      console.log(`Skipping very small text part (${text.length} chars)`);
      return [];
    }
    return [text];
  }

  const findSafePartEnd = (start: number, maxEnd: number): number => {
    const minEnd = Math.min(start + MIN_TEXT_PART_LENGTH, text.length);
    let end = maxEnd;

    // Prefer sentence/paragraph boundaries first.
    while (end > minEnd && !/\n\n|[.!?]\s/.test(text.slice(end - 1, end + 1))) {
      end -= 1;
    }

    // If no sentence boundary is available, back up to a word boundary.
    if (end <= minEnd) {
      end = maxEnd;
      while (end > minEnd && end < text.length && /[a-zA-Z0-9]/.test(text[end - 1]) && /[a-zA-Z0-9]/.test(text[end])) {
        end -= 1;
      }
    }

    // Final fallback for pathological tokens without boundaries.
    if (end <= start) {
      end = maxEnd;
    }

    return end;
  };

  const parts: string[] = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    const maxEnd = Math.min(currentPos + MAX_TEXT_PART_CHARS, text.length);
    const end = findSafePartEnd(currentPos, maxEnd);
    const part = text.slice(currentPos, end).trim();
    if (part.length >= MIN_TEXT_PART_LENGTH) {
      parts.push(part);
    } else if (part.length > 0) {
      // If we have a small part and previous parts, merge with the last part
      if (parts.length > 0) {
        parts[parts.length - 1] += '\n\n' + part;
      } else {
        console.log(`Skipping very small text part (${part.length} chars)`);
      }
    }
    currentPos = end;
  }

  return parts.filter(part => part.trim().length >= MIN_TEXT_PART_LENGTH);
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
): Segment[] {
  const segments: Segment[] = [];
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
): Segment[] {
  const segments: Segment[] = [];
  
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

function validateSegmentLength(segments: Segment[], totalWordCount: number): boolean {
  // For very short texts (under 1000 words), be more lenient with segment length
  const minLength = totalWordCount < 1000 ? 10 : 20;
  const invalidSegments = segments.filter(seg => seg.text.trim().length < minLength);
  
  if (invalidSegments.length > 0) {
    console.warn(`Found ${invalidSegments.length} segments with less than ${minLength} characters:`, 
                 invalidSegments.map(seg => ({ length: seg.text.length, start: seg.start })));
    
    // For short texts, allow up to 20% of segments to be shorter than the minimum
    if (totalWordCount < 1000) {
      const allowedShortSegments = Math.ceil(segments.length * 0.2);
      if (invalidSegments.length <= allowedShortSegments) {
        console.log(`Allowing ${invalidSegments.length} short segments for text under 1000 words`);
        return true;
      }
    }
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

function createAudioBasedSegments(
  text: string,
  totalImages: number,
  firstPageImages: number | null,
  audioDistributionType: 'consistent' | 'variable'
): Segment[] {
  // Audio mode: use exact image counts (no buffer increase)
  // The 18% buffer is only for word count mode where we estimate based on reading speed
  // For audio mode, we have precise duration so use exact counts
  console.log(`Audio-based segmentation: ${totalImages} total images (exact count, no buffer)`);
  if (firstPageImages) {
    console.log(`  First page: ${firstPageImages} images, Rest: ${totalImages - firstPageImages} images`);
  }
  
  // Use the existing createCountBasedSegments with exact counts
  return createCountBasedSegments(text, totalImages, firstPageImages);
}

function segmentText(text: string, firstPageSeconds: number, restSeconds: number, startPosition: number = 0, model: string = 'sonnet'): Segment[] {
  // TRADITIONAL FREQUENCY-BASED SEGMENTATION (matching Python exactly)
  // Return empty array for text that's too short to process
  if (text.length < MIN_TEXT_PART_LENGTH) {
    console.log(`Text too short (${text.length} chars) to segment, skipping`);
    return [];
  }
  
  // Clean text for prompt generation (removes title and first chapter header)
  const cleanedText = cleanTextForPrompts(text);
  
  // Detect chapter sections
  const chapterSections = detectChapterSections(cleanedText);
  
  const allSegments: Segment[] = [];
  
  // Process each chapter section
  for (const section of chapterSections) {
    const sectionSegments = segmentChapterSection(
      section.text,
      section.startPos,
      firstPageSeconds,
      restSeconds,
      startPosition
    );
    allSegments.push(...sectionSegments);
  }
  
  // Add validation logging
  const firstPageSegments = allSegments.filter(s => s.is_first_page).length;
  const restSegments = allSegments.length - firstPageSegments;
  
  console.log(`Chapter-aware segmentation summary:`);
  console.log(`  Chapters detected: ${chapterSections.length}`);
  
  // Check if using consistent frequency (same frequency for both first page and rest)
  if (firstPageSeconds === restSeconds) {
    console.log(`  Consistent frequency mode: ${allSegments.length} total segments (every ${firstPageSeconds}s)`);
  } else {
    console.log(`  First page segments: ${firstPageSegments} (every ${firstPageSeconds}s)`);
    console.log(`  Rest segments: ${restSegments} (every ${restSeconds}s)`);
    console.log(`  Total segments: ${allSegments.length}`);
  }
  
  return allSegments;
}

// OLD IMPLEMENTATION REMOVED - using chapter-aware approach above
function segmentText_OLD_UNUSED(text: string, firstPageSeconds: number, restSeconds: number, startPosition: number = 0, model: string = 'sonnet'): Segment[] {
  // Return empty array for text that's too short to process
  if (text.length < MIN_TEXT_PART_LENGTH) {
    console.log(`Text too short (${text.length} chars) to segment, skipping`);
    return [];
  }
  
  const cleanedText = cleanTextForPrompts(text);
  
  // Calculate total images based on story characteristics (matching Python logic)
  const wordCount = calculateWordCount(cleanedText);
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

function determineBatchCount(segments: Segment[], restFrequency: number, model: string = 'sonnet'): number {
  // Apply different batching for Anthropic models and segment types
  const isAnthropic = model === 'sonnet' || model === 'opus';
  
  // Separate segments by type
  const firstPageSegments = segments.filter(seg => seg.is_first_page);
  const restSegments = segments.filter(seg => !seg.is_first_page);
  
  // Determine batch sizes for each type
  const firstPageBatchSize = isAnthropic ? 4 : 2;
  const restBatchSize = isAnthropic 
    ? (restFrequency > 120 ? 2 : 4)
    : (restFrequency > 120 ? 1 : 2);
  
  // Calculate batch count
  const firstPageBatches = Math.ceil(firstPageSegments.length / firstPageBatchSize);
  const restBatches = Math.ceil(restSegments.length / restBatchSize);
  
  return firstPageBatches + restBatches;
}

function assignBatches(segments: Segment[], restFrequency: number, model: string = 'sonnet'): number[][] {
  const batches: number[][] = [];
  
  // Apply different batching for Anthropic models and segment types
  const isAnthropic = model === 'sonnet' || model === 'opus';
  
  // Separate segments by type with their original indices
  const firstPageIndices: number[] = [];
  const restIndices: number[] = [];
  
  segments.forEach((seg, index) => {
    if (seg.is_first_page) {
      firstPageIndices.push(index);
    } else {
      restIndices.push(index);
    }
  });
  
  // Determine batch sizes for each type
  const firstPageBatchSize = isAnthropic ? 4 : 2;
  const restBatchSize = isAnthropic 
    ? (restFrequency > 120 ? 2 : 4)
    : (restFrequency > 120 ? 1 : 2);
  
  // Create batches for first page segments
  for (let i = 0; i < firstPageIndices.length; i += firstPageBatchSize) {
    const batch = firstPageIndices.slice(i, i + firstPageBatchSize);
    batches.push(batch);
  }
  
  // Create batches for rest segments
  for (let i = 0; i < restIndices.length; i += restBatchSize) {
    const batch = restIndices.slice(i, i + restBatchSize);
    batches.push(batch);
  }
  
  return batches;
}

async function insertTasksInBatches(tasks: Task[], startTime: number, maxRuntime: number) {
  const totalTasks = tasks.length;
  console.log(`Inserting ${totalTasks} tasks in batches of ${BATCH_SIZE}`);

  for (let i = 0; i < totalTasks; i += BATCH_SIZE) {
    if (Date.now() - startTime > maxRuntime * 0.9) {
      throw new Error(`Approaching runtime limit during batch insertion at batch ${Math.floor(i / BATCH_SIZE) + 1}`);
    }

    const batch = tasks.slice(i, i + BATCH_SIZE);
    for (const task of batch) {
      const payloadSize = JSON.stringify(task).length;
      if (payloadSize > 10000) {
        console.warn(`Task ${task.id} payload size ${payloadSize} bytes exceeds recommended 10,000 bytes`);
      }
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const { error } = await supabase.from('image_prompt_tasks').insert(batch);
        if (error) throw new Error(`Failed to insert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
        console.log(`Successfully inserted batch ${Math.floor(i / BATCH_SIZE) + 1}`);
        break;
      } catch (error: any) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          continue;
        }
        throw error;
      }
    }

    if (i + BATCH_SIZE < totalTasks) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
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
         errorMsg.includes('Failed to trigger batch');
}

async function getTextPartFromContext(groupId: string, textPart: string): Promise<string> {
  // Check if text_part is a number (new format)
  const partNumber = parseInt(textPart, 10);
  
  if (!isNaN(partNumber) && partNumber > 0) {
    // New format: fetch from context
    console.log(`Fetching text part ${partNumber} from context for group ${groupId}`);
    const { data, error } = await supabase
      .from('image_prompt_context')
      .select('full_story_text')
      .eq('group_id', groupId)
      .eq('part_number', partNumber)
      .single();
    
    if (error || !data) {
      console.error(`Failed to fetch text part ${partNumber}:`, error);
      throw new Error(`Failed to fetch text part ${partNumber} from context`);
    }
    
    console.log(`Successfully fetched part ${partNumber}: ${data.full_story_text.length} chars`);
    return data.full_story_text;
  } else {
    // Old format: text_part contains the actual text (backward compatibility)
    console.log(`Using text_part directly (backward compatibility): ${textPart.length} chars`);
    return textPart;
  }
}

async function triggerNextBatch(group_id: string, user_id: string, currentBatchNumber: number, tab: number = 1, variant: number = 1) {
  try {
    const _sk = Deno.env.get("SUPABASE_SECRET_KEY") || "";
    const response = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/trigger-image-next-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': _sk,
      },
      body: JSON.stringify({
        group_id,
        user_id,
        current_batch_number: currentBatchNumber,
        tab: tab,
        variant: variant,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger next batch: HTTP ${response.status} - ${errorText}`);
    }
    console.log(`Successfully triggered next batch for group_id: ${group_id}, batch_number: ${currentBatchNumber + 1}, tab: ${tab}, variant: ${variant}`);
  } catch (error: any) {
    console.error(`Failed to trigger batch for group_id: ${group_id}, batch_number: ${currentBatchNumber + 1}, tab: ${tab}, variant: ${variant}: ${error.message}`);
    
    // Check if it's a retryable error and set to 'running' instead of 'pending'
    const status = isRetryableError(error) ? 'running' : 'pending';
    
    await supabase
      .from('image_prompt_tasks')
      .update({ status, error: `Failed to trigger batch: ${error.message}`, updated_at: new Date().toISOString() })
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', currentBatchNumber + 1)
      .eq('tab', tab)
      .eq('variant', variant);
  }
}

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

Deno.serve(async (req) => {
  const corsOrigin = getCorsOrigin(req);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }

  try {
    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
      });
    }    // authToken resolved above (Bearer or apikey)
    const _secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || '';
    const _allowedServerKeys = [_secretKey].filter(Boolean);
    let userId: string | null = null;
    if (!_allowedServerKeys.includes(authToken)) {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      userId = _authUser.id;
    }

    const startTime = Date.now();
    const maxRuntime = 300000;
    const requestData: JobRequest = await req.json();
    // Override user_id from JWT for non-service-role calls
    if (userId) {
      requestData.user_id = userId;
    }
    const { jobId, user_id } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!jobId || !uuidRegex.test(jobId)) throw new Error('Missing or invalid jobId');
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');

    const { data: jobData, error: jobError } = await supabase
      .from('job_data')
      .select('data')
      .eq('id', jobId)
      .eq('user_id', user_id)
      .single();
    if (jobError || !jobData) throw new Error(`Failed to fetch job data: ${jobError?.message || 'No job found'}`);

    const {
      textParts,
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
      characters,
      totalInputTokens,
      totalOutputTokens,
      is_corrected,
      taskIds,
      totalPrompts,
      userTokenBalance,
      videoProcess,
      language,
      model, // Extract model from job data
      processImage, // Add this line
      tab = 1, // Extract tab from job_data with default of 1
      frequencyMode = 'wordcount',
      frequencyType = 'variable',
      audioDistributionType = null,
      imageAmount = null,
      audioFirstPageImageCount = null,
      audioRestImageCount = null,
    } = jobData.data;

    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id from job data');
    if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id from job data');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path from job data');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title from job data');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description from job data');
    if (!style || typeof style !== 'string') throw new Error('Missing or invalid style from job data');
    if (typeof useCharacterDescriptions !== 'boolean') throw new Error('Missing or invalid useCharacterDescriptions from job data');
    
    // Validate based on frequency mode
    if (frequencyMode === 'audio') {
      // Audio mode validation - frequencies are not used, segmentation was done in setup-prompt
      console.log('Audio mode detected - skipping frequency validation');
    } else {
      // Word count mode validation
      if (frequencyType === 'consistent') {
        // In consistent mode, firstPageFrequency will equal restFrequency (set in setup-prompt)
        // Both should be the same value within 5-300 range
        if (typeof firstPageFrequency !== 'number' || firstPageFrequency < 5 || firstPageFrequency > 300) {
          throw new Error('Invalid firstPageFrequency for consistent mode (must be 5–300) from job data');
        }
      } else {
        // Variable mode: validate standard ranges
        if (typeof firstPageFrequency !== 'number' || firstPageFrequency < 5 || firstPageFrequency > 120) {
          throw new Error('Invalid firstPageFrequency (must be 5–120) from job data');
        }
      }
      
      if (typeof restFrequency !== 'number' || restFrequency < 5 || restFrequency > 300) {
        throw new Error('Invalid restFrequency (must be 5–300) from job data');
      }
    }
    
    if (typeof variant !== 'number') throw new Error('Missing or invalid variant from job data');
    if (typeof userTokenBalance !== 'number') throw new Error('Missing or invalid userTokenBalance from job data');
    if (!Array.isArray(textParts) || textParts.length === 0) throw new Error('Invalid textParts from job data');

    // Validate language and model
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language || '') ? language : 'english';
    
    const supportedModels = ['deepseek', 'sonnet', 'opus'];
    const validatedModel = supportedModels.includes(model || '') ? model : 'sonnet';

    // Validate processImage
    const shouldProcessImage = processImage === true;

    const estimatedTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);

    // Check for existing recent tasks to prevent duplicates
    // Allow different variants to coexist by checking group_id + variant combination
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('image_prompt_tasks')
      .select('*', { count: 'exact', head: true })
      .eq('group_id', group_id)
      .eq('variant', variant)
      .eq('tab', tab)
      .gte('created_at', fiveMinutesAgo);

    if (count && count > 0) {
      console.log(`Processing already in progress for group_id: ${group_id}, variant: ${variant}, tab: ${tab}, found ${count} recent tasks`);
      return new Response(JSON.stringify({ error: `Processing already in progress for this group with variant ${variant}` }), {
        status: 409,
        headers: {
          "Content-Type": "application/json",
          'Access-Control-Allow-Origin': corsOrigin,
        },
      });
    }

    const allTasks: Task[] = [];
    let globalBatchNumber = 0;
    let globalPromptCount = 0;
    let charPosition = 0;

    // Calculate total character count across all parts for proportional distribution
    let totalCharCount = 0;
    for (const part of textParts) {
      const partText = await getTextPartFromContext(group_id, part);
      totalCharCount += partText.length;
    }
    console.log(`Total character count across ${textParts.length} parts: ${totalCharCount}`);

    for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
      const partText = await getTextPartFromContext(group_id, textParts[partIdx]);
      const cappedTextParts = splitTextIfLarge(partText);
      
      // Skip if no valid sub-parts
      if (cappedTextParts.length === 0) {
        console.log(`Text part ${partIdx + 1} has no valid sub-parts, skipping`);
        charPosition += partText.length;
        continue;
      }
      
      console.log(`Text part ${partIdx + 1} split into ${cappedTextParts.length} sub-parts`);

      for (let subPartIdx = 0; subPartIdx < cappedTextParts.length; subPartIdx++) {
        const subPartText = cappedTextParts[subPartIdx];
        const charCount = subPartText.length;
        const wordCount = calculateWordCount(subPartText);
        console.log(`Processing sub-part ${partIdx + 1}.${subPartIdx + 1}, chars: ${charCount}, words: ${wordCount}`);
        
        // Skip very small sub-parts
        if (charCount < MIN_TEXT_PART_LENGTH) {
          console.log(`Skipping very small sub-part ${partIdx + 1}.${subPartIdx + 1} (${charCount} chars)`);
          continue;
        }
        
        if (charCount > MAX_TEXT_PART_CHARS) {
          console.warn(`Sub-part ${partIdx + 1}.${subPartIdx + 1} exceeds ${MAX_TEXT_PART_CHARS} chars`);
        }

        let segments: Segment[];
        
        if (frequencyMode === 'audio') {
          // Audio-based segmentation using image counts
          console.log(`Using audio-based segmentation mode: ${audioDistributionType}`);
          
          // Calculate proportional image count for this sub-part based on character count
          const subPartCharRatio = charCount / totalCharCount;
          
          if (audioDistributionType === 'consistent') {
            // Consistent: distribute imageAmount proportionally across parts
            const fullTotalImages = imageAmount || 10;
            const totalImages = Math.max(1, Math.round(fullTotalImages * subPartCharRatio));
            console.log(`  Consistent distribution: ${totalImages} images for this part (${(subPartCharRatio * 100).toFixed(1)}% of ${fullTotalImages} total)`);
            
            segments = createAudioBasedSegments(subPartText, totalImages, null, 'consistent');
          } else {
            // Variable: distribute first page and rest counts proportionally
            const fullFirstPageCount = audioFirstPageImageCount || 5;
            const fullRestCount = audioRestImageCount || 5;
            const fullTotalCount = fullFirstPageCount + fullRestCount;
            
            const firstPageCount = Math.max(1, Math.round(fullFirstPageCount * subPartCharRatio));
            const restCount = Math.max(0, Math.round(fullRestCount * subPartCharRatio));
            const totalCount = firstPageCount + restCount;
            console.log(`  Variable distribution: ${firstPageCount} first page + ${restCount} rest = ${totalCount} images for this part (${(subPartCharRatio * 100).toFixed(1)}% of ${fullTotalCount} total)`);
            
            segments = createAudioBasedSegments(subPartText, totalCount, firstPageCount, 'variable');
          }
        } else {
          // Word count based segmentation
          if (frequencyType === 'consistent') {
            // Consistent mode: use chapter-aware segmentation with same frequency for both first page and rest
            // This matches Python's behavior where consistent mode still uses segment_text() 
            // but with both frequencies set to the same value
            console.log(`Word count consistent mode: using ${restFrequency}s frequency for entire story (chapter-aware)`);
            
            segments = segmentText(subPartText, restFrequency, restFrequency, charPosition, validatedModel);
          } else {
            // Variable mode: use time-based segmentation with first page distinction
            segments = segmentText(subPartText, firstPageFrequency, restFrequency, charPosition, validatedModel);
          }
        }
        
        // Skip empty segments arrays
        if (segments.length === 0) {
          console.log(`No valid segments generated for sub-part ${partIdx + 1}.${subPartIdx + 1}, skipping`);
          continue;
        }
        
        // Final validation check - segments should be valid after retries
        const totalWords = calculateWordCount(subPartText);
        if (!validateSegmentLength(segments, totalWords)) {
          console.warn(`Sub-part ${partIdx + 1}.${subPartIdx + 1} has segments shorter than minimum after retries, but proceeding`);
        }
        
        globalPromptCount += segments.length;
        const batchCount = determineBatchCount(segments, restFrequency, validatedModel);
        const batchIndices = assignBatches(segments, restFrequency, validatedModel);

        const batches: Segment[][] = [];
        for (const batch of batchIndices) {
          batches.push(batch.map(idx => segments[idx]).filter(seg => seg));
        }

        for (let i = 0; i < batches.length; i++) {
          const taskId = crypto.randomUUID();
          const isFirstBatch = globalBatchNumber + 1 === 1;
          
          const taskPayload: Task = {
            id: taskId,
            user_id,
            group_id,
            story_title,
            description,
            batch: batches[i],
            text_part: textParts[partIdx],
            batch_output: '',
            total_batches: 0, // Will update after calculating globalBatchNumber
            batch_number: globalBatchNumber + 1,
            total_prompts: globalPromptCount,
            status: isFirstBatch ? 'queued' : 'pending',
            progress: 0,
            error: null,
            settings: {
              style,
              useCharacterDescriptions,
              firstPageFrequency: String(firstPageFrequency),
              restFrequency: String(restFrequency),
              characters,
            },
            variant,
            doc_id,
            file_path,
            input_tokens: 0, // Set to 0 for Deno Deploy
            output_tokens: 0, // Set to 0 for Deno Deploy
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            version: is_corrected ? 4 : 3,
            image_model: jobData.data.imageModel || 'plus',
            video_process: videoProcess || false,
            language: validatedLanguage,
            model: validatedModel, // Add model field
            process_image: shouldProcessImage, // Add this line
            tab: tab, // Add tab field
          };
          allTasks.push(taskPayload);
          globalBatchNumber += 1;
        }
        
        charPosition += subPartText.length;
      }
    }

    // If no valid tasks were created, return an error
    if (allTasks.length === 0) {
      throw new Error("No valid tasks could be created from the provided text. Please check your content and settings.");
    }

    // Update total_batches in all tasks
    for (const task of allTasks) {
      task.total_batches = globalBatchNumber;
    }

    // Update job_data with correct totalBatches and totalPrompts
    const { error: updateJobError } = await supabase
      .from('job_data')
      .update({
        data: {
          ...jobData.data,
          totalBatches: globalBatchNumber,
          totalPrompts: globalPromptCount,
        },
      })
      .eq('id', jobId);
    if (updateJobError) console.error(`Failed to update job data: ${updateJobError.message}`);

    await insertTasksInBatches(allTasks, startTime, maxRuntime);

    const firstTask = allTasks.find(task => task.batch_number === 1);
    if (firstTask) {
      const { error } = await supabase
        .from('image_prompt_tasks')
        .update({ status: 'queued', updated_at: new Date().toISOString() })
        .eq('id', firstTask.id);
      if (error) throw new Error(`Failed to queue first batch: ${error.message}`);
      console.log(`Queued first batch: task_id ${firstTask.id}`);
    }

    await triggerNextBatch(group_id, user_id, 0, tab, variant); // Pass tab and variant to triggerNextBatch

    const { error: deleteError } = await supabase
      .from('job_data')
      .delete()
      .eq('id', jobId);
    if (deleteError) console.error(`Failed to delete job data: ${deleteError.message}`);
    else console.log(`Successfully deleted job data for jobId: ${jobId}`);

    return new Response(JSON.stringify({
      task_ids: allTasks.map(task => task.id),
      total_batches: globalBatchNumber,
      total_prompts: globalPromptCount,
      input_tokens: 0,
      output_tokens: 0,
      language: validatedLanguage,
      model: validatedModel, // Return validated model
      tab: tab, // Return tab in response
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (error: any) {
    console.error(`Error in process-task: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }
});



