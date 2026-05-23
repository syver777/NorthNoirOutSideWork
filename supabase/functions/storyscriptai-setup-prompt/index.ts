
import { createClient } from 'npm:@supabase/supabase-js@2';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';

interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string;
  story_title: string;
  description: string;
  style: string;
  useCharacterDescriptions: boolean;
  firstPageFrequency: number | null; // NULL for consistent frequency mode
  restFrequency: number;
  variant: number;
  doc_id: string;
  userTokenBalance: number;
  imageModel?: string;
  videoProcess?: boolean;
  language?: string;
  model?: string; // Add this field
  processImage?: boolean; // Add this field
  tab?: number; // Add tab support
  masterPromptData?: any; // V2: Master Prompt support
  environmentOnlyMode?: boolean; // V2: Environment-only mode
  // New frequency mode fields
  frequencyMode?: 'wordcount' | 'audio';
  frequencyType?: 'consistent' | 'variable';
  consistentFrequency?: number;
  audioFiles?: Array<{ path: string; name: string; duration: number; url?: string }>;
  totalAudioDuration?: number;
  imageAmount?: number;
  audioDistributionType?: 'consistent' | 'variable';
  audioFirstPageImageCount?: number;
  audioRestImageCount?: number;
  // Custom character fields
  customCharactersEnabled?: boolean;
  customCharacters?: Array<{ name: string; description: string }>;
  customCharactersAIEnhance?: boolean;
}

interface Segment {
  text: string;
  start: number;
  is_first_page: boolean;
}

const TOKEN_PER_WORD = 1.33;
const MAX_RETRIES = 3;
const MAX_WORDS_PER_PART = 8000;
const MIN_TEXT_PART_LENGTH = 100;
const CHARS_PER_SECOND = 13.67; // Updated character reading speed

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);

// Add the mapping function
const getBackendImageModel = (frontendModel: string): string => {
  const modelMap = {
    'standard': 'imagen-4-fast',
    'plus': 'gpt-image-1-mini', 
    'premium': 'imagen-4-ultra',
    'spark': 'flux-2-dev',
    'grok': 'grok-imagine-image',
    'prime': 'seedream-4.5',
    'genesis': 'nano-banana-pro'
  };
  return modelMap[frontendModel as keyof typeof modelMap] || 'gpt-image-1-mini';
};

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
  const totalWords = calculateWordCount(text);
  if (totalWords <= MAX_WORDS_PER_PART) {
    return [text];
  }

  const paragraphs = text.split('\n\n');
  const parts: string[] = [];
  let currentPart: string[] = [];
  let currentWordCount = 0;

  for (const para of paragraphs) {
    const paraWords = calculateWordCount(para);
    if (currentWordCount + paraWords > MAX_WORDS_PER_PART && currentPart.length > 0) {
      parts.push(currentPart.join('\n\n'));
      currentPart = [para];
      currentWordCount = paraWords;
    } else {
      currentPart.push(para);
      currentWordCount += paraWords;
    }
  }

  if (currentPart.length > 0) {
    parts.push(currentPart.join('\n\n'));
  }

  // Merge very small parts with the previous part
  const mergedParts: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const currentPart = parts[i];
    if (currentPart.length < MIN_TEXT_PART_LENGTH && i > 0) {
      // Merge with previous part
      mergedParts[mergedParts.length - 1] += '\n\n' + currentPart;
    } else if (currentPart.length >= MIN_TEXT_PART_LENGTH) {
      mergedParts.push(currentPart);
    } else {
      // Skip very small parts at the beginning if they can't be merged
      console.log(`Skipping very small text part (${currentPart.length} chars)`);
    }
  }

  return mergedParts.filter(part => part.trim().length >= MIN_TEXT_PART_LENGTH);
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
    const forwardPos = targetPos + offset;
    if (forwardPos < text.length) {
      const char = text[forwardPos];
      const nextChar = forwardPos + 1 < text.length ? text[forwardPos + 1] : '';
      if (['.', '!', '?'].includes(char) && [' ', '\n', '\r'].includes(nextChar)) {
        return forwardPos + 1;
      }
    }
    
    // Check backward
    const backwardPos = targetPos - offset;
    if (backwardPos >= 0) {
      const char = text[backwardPos];
      const nextChar = backwardPos + 1 < text.length ? text[backwardPos + 1] : '';
      if (['.', '!', '?'].includes(char) && [' ', '\n', '\r'].includes(nextChar)) {
        return backwardPos + 1;
      }
    }
  }

  // Look for paragraph boundaries within ±200 chars
  const searchRange2 = 200;
  for (let offset = 0; offset < searchRange2; offset++) {
    // Check forward
    const forwardPos = targetPos + offset;
    if (forwardPos < text.length - 1 && text[forwardPos] === '\n' && text[forwardPos + 1] === '\n') {
      return forwardPos + 2;
    }
    
    // Check backward
    const backwardPos = targetPos - offset;
    if (backwardPos >= 0 && backwardPos < text.length - 1 && text[backwardPos] === '\n' && text[backwardPos + 1] === '\n') {
      return backwardPos + 2;
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
      // Find optimal split point near target position
      const targetPos = Math.round(currentPos + segmentSize);
      const splitPos = findOptimalSplitPoint(text, targetPos);
      
      const segmentText = text.slice(currentPos, splitPos).trim();
      if (segmentText) {
        segments.push({
          text: segmentText,
          start: currentPos,
          is_first_page: false
        });
      }
      
      currentPos = splitPos;
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
      if (skipFirstTitle) {
        skipFirstTitle = false;
      }
      continue; // Skip all chapter headers
    } else if (skipFirstTitle && line.trim() && !line.trim().startsWith('**')) {
      // Skip the first non-chapter, non-bold line (the title)
      skipFirstTitle = false;
      continue;
    } else {
      skipFirstTitle = false;
      cleanedLines.push(line);
    }
  }

  const cleanedText = cleanedLines.join('\n').trim();

  if (firstPageImages === null) {
    // Simple case: split entire text into totalImages segments
    return splitTextIntoNSegments(cleanedText, totalImages);
  } else {
    // Complex case: handle first page separately
    const firstPageChars = Math.min(3000, cleanedText.length);
    const firstPageText = cleanedText.slice(0, firstPageChars);
    const restText = cleanedText.slice(firstPageChars);

    const restImages = totalImages - firstPageImages;

    // Split first page into firstPageImages segments
    const firstPageSegments = splitTextIntoNSegments(firstPageText, firstPageImages);
    firstPageSegments.forEach(seg => {
      seg.is_first_page = true;
    });

    // Split rest into restImages segments
    const restSegments = splitTextIntoNSegments(restText, restImages);
    restSegments.forEach(seg => {
      seg.start += firstPageChars;
      seg.is_first_page = false;
    });

    return [...firstPageSegments, ...restSegments];
  }
}

function createAudioBasedSegments(
  text: string,
  totalImages: number,
  firstPageImages: number | null,
  audioDistributionType: 'consistent' | 'variable'
): Segment[] {
  // Audio mode: use exact image counts (no buffer, no adjustments)
  // Unlike word count mode which estimates based on reading speed and adds 18% buffer,
  // audio mode uses precise duration data so we create exactly the requested number.
  // This matches the Python implementation which guarantees exact counts.
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

function determineBatchCount(segments: Segment[], restFrequency: number, model: string = 'sonnet'): [number, number, number] {
  const totalWords = segments.reduce((sum, seg) => sum + calculateWordCount(seg.text), 0) + 150 * segments.length;
  const estimatedTokens = estimateTokens(JSON.stringify(segments));
  
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
  const batchCount = firstPageBatches + restBatches;
  
  return [batchCount, estimatedTokens, estimateTokens(String(batchCount))];
}

function assignBatches(segments: Segment[], restFrequency: number, model: string = 'sonnet'): [number[][], number, number] {
  const estimatedTokens = estimateTokens(JSON.stringify(segments));
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
  
  return [batches, estimatedTokens, estimateTokens(String(batches))];
}

async function extractCharacterDescriptions(text: string): Promise<{
  characters: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
}> {
  // Matching Python implementation exactly (lines 1386-1453)
  const systemPrompt = `You are an expert character analyst. Read the provided story text and identify up to 5 main characters (or fewer if there are less) based on their role in the story, frequency of appearance, and impact on the plot. For each, create a detailed 3-4 sentence description focusing ONLY on their visual appearance. You MUST include ALL of the following for each human character: approximate age range, physical build, face (skin tone, eye color, facial hair or clean-shaven), hair (specific color, length, texture, and style e.g. "short curly black hair"), clothing (full outfit description including tops, bottoms, and layers with colors), footwear (specific shoe/boot type or barefoot), and accessories (glasses, jewelry, hats, watches, scarves, or "no accessories"). If the text does not explicitly describe any required attribute (hair, eyes, skin tone, build, age, facial features, clothing, footwear, or accessories), you MUST commit to one specific, plausible value inferred from the character's age, role, setting, time period, and overall story tone — this is required so the character stays visually consistent across scenes. NEVER write hedge phrases like "not specified", "not mentioned", "unknown", "indeterminate", "unspecified", or "no [X] mentioned", and never leave any attribute blank. Keep inferred details simple and natural; do not over-elaborate or invent dramatic features the story does not support. For animal characters: describe species, breed/type, fur/feather color and pattern, size, and distinguishing markings—do NOT add clothing unless the story explicitly describes the animal wearing clothes. Output a JSON object where each key is a character's name and the value is their visual description as a string. Return only the JSON object.`;
  const userPrompt = `Extract main character descriptions from this text:\n${text}`;
  
  const retries = 5;
  const delay = 5;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get("DEEPSEEK_API_KEY") || ""}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 4000,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`DeepSeek API error: ${errorText}`);
      }

      let jsonOutput = (await response.json()).choices[0].message.content.trim();
      const inputTokens = estimateTokens(systemPrompt + userPrompt);
      const outputTokens = estimateTokens(jsonOutput);
      
      // Clean up JSON markers
      if (jsonOutput.startsWith('```json')) {
        jsonOutput = jsonOutput.slice(7);
      }
      if (jsonOutput.endsWith('```')) {
        jsonOutput = jsonOutput.slice(0, -3);
      }

      const characters = JSON.parse(jsonOutput.trim());
      
      // Apply token multiplier for cost normalization (matching Python line 1431-1433)
      const tokenMultiplier = 1.0; // deepseek model
      const adjustedInputTokens = Math.round(inputTokens * tokenMultiplier);
      const adjustedOutputTokens = Math.round(outputTokens * tokenMultiplier);
      
      console.log(`Successfully extracted ${Object.keys(characters).length} characters`);
      for (const [name, description] of Object.entries(characters)) {
        console.log(`  - ${name}: ${String(description).substring(0, 80)}...`);
      }
      
      return { characters, inputTokens: adjustedInputTokens, outputTokens: adjustedOutputTokens };
    } catch (error: any) {
      const errorMsg = error.message?.toLowerCase() || '';
      const isRetryable = errorMsg.includes('connection') || 
                         errorMsg.includes('timeout') || 
                         errorMsg.includes('network') || 
                         errorMsg.includes('429') || 
                         errorMsg.includes('500') || 
                         errorMsg.includes('503') || 
                         errorMsg.includes('overloaded') ||
                         errorMsg.includes('connection error') ||
                         error.name === 'AbortError';
      
      if (error.name === 'SyntaxError' || errorMsg.includes('json')) {
        // JSON parse error
        if (attempt < retries - 1) {
          const waitTime = delay * Math.pow(2, attempt);
          console.log(`JSON error: ${error.message}. Retrying in ${waitTime}s... (Attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
          continue;
        }
        throw new Error(`Failed to parse characters after ${retries} attempts: ${error.message}`);
      } else if (isRetryable) {
        // Connection/API error
        if (attempt < retries - 1) {
          const waitTime = delay * Math.pow(2, attempt);
          console.log(`Connection/API error: ${error.message}. Retrying in ${waitTime}s... (Attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
          continue;
        }
        throw new Error(`Failed after ${retries} attempts: ${error.message}`);
      }
      throw error;
    }
  }
  throw new Error(`Failed to extract characters after ${retries} attempts`);
}

async function enhanceCustomCharacterDescriptions(
  characters: Array<{ name: string; description: string }>,
  storyTitle: string,
  style: string
): Promise<{
  enhanced: Record<string, string>;
  inputTokens: number;
  outputTokens: number;
}> {
  const characterList = characters
    .filter(c => c.name.trim())
    .map(c => `- ${c.name}: ${c.description || 'No description provided'}`)
    .join('\n');

  const systemPrompt = `You are an expert visual character designer. Given a list of characters with basic descriptions, expand each into a detailed visual description optimized for image generation. You MUST include ALL of these attributes for each human character: physical build and age range, face (skin tone, eye color, facial hair), hair (specific color, length, texture, style e.g. "short curly black hair"), clothing (full outfit: tops, bottoms, layers with colors), footwear (specific type or barefoot), and accessories (glasses, jewelry, hats, etc. or "no accessories"). For any required attribute the user did not specify, infer one specific, plausible value from the character's role, setting, time period, and overall story tone — NEVER use hedge phrases like "not specified", "not mentioned", "unknown", "indeterminate", "unspecified", or "no [X] mentioned", and never leave any attribute blank. Keep inferred details simple and natural; do not over-elaborate. For animal characters: describe species, breed/type, fur/feather color and pattern, size, and distinguishing markings—do NOT add clothing unless explicitly described. Keep each description 3-4 sentences. The story title is "${storyTitle}" and the visual style is: ${style.substring(0, 200)}. Output a JSON object where each key is the character's name (exactly as given) and the value is the enhanced visual description string. Return only the JSON object.`;
  const userPrompt = `Enhance these character descriptions for image generation:\n${characterList}`;

  const retries = 3;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get("DEEPSEEK_API_KEY") || ""}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 3000,
          temperature: 0.7,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${await response.text()}`);
      }

      let jsonOutput = (await response.json()).choices[0].message.content.trim();
      const inputTokens = estimateTokens(systemPrompt + userPrompt);
      const outputTokens = estimateTokens(jsonOutput);

      if (jsonOutput.startsWith('```json')) jsonOutput = jsonOutput.slice(7);
      if (jsonOutput.startsWith('```')) jsonOutput = jsonOutput.slice(3);
      if (jsonOutput.endsWith('```')) jsonOutput = jsonOutput.slice(0, -3);

      const enhanced = JSON.parse(jsonOutput.trim());
      console.log(`Successfully enhanced ${Object.keys(enhanced).length} custom characters`);
      return { enhanced, inputTokens, outputTokens };
    } catch (error: any) {
      if (attempt < retries - 1) {
        const waitTime = 3 * Math.pow(2, attempt);
        console.log(`Enhancement attempt ${attempt + 1} failed: ${error.message}. Retrying in ${waitTime}s...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
        continue;
      }
      // On final failure, fall back to raw descriptions
      console.error(`Failed to enhance characters after ${retries} attempts, using raw descriptions`);
      const fallback: Record<string, string> = {};
      for (const char of characters) {
        if (char.name.trim()) {
          fallback[char.name.trim()] = char.description || 'A character in the story.';
        }
      }
      return { enhanced: fallback, inputTokens: 0, outputTokens: 0 };
    }
  }
  // Unreachable, but TypeScript needs it
  const fallback: Record<string, string> = {};
  for (const char of characters) {
    if (char.name.trim()) {
      fallback[char.name.trim()] = char.description || 'A character in the story.';
    }
  }
  return { enhanced: fallback, inputTokens: 0, outputTokens: 0 };
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
    const _srvKey = Deno.env.get('SECRET_KEY') || '';
    const _secretKey = Deno.env.get('SECRET_KEY') || '';
    let _authenticatedUserId: string | null = null;

    if (authToken === _srvKey || authToken === _secretKey) {
      // Server-to-server call (legacy or new secret key)
    } else {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { "Content-Type": "application/json", 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      _authenticatedUserId = _authUser.id;
    }

    const startTime = Date.now();
    const maxRuntime = 300000;
    const requestData: SetupRequest = await req.json();

    // When JWT auth is used, override body user_id with authenticated user
    if (_authenticatedUserId && requestData.user_id) {
      requestData.user_id = _authenticatedUserId;
    }

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
      videoProcess,
      language,
      model, // Extract model
      processImage, // Add this line
      tab = 1, // Add tab with default value of 1
      masterPromptData, // Master Prompt
      environmentOnlyMode = false, // Environment-only mode
      frequencyMode = 'wordcount',
      frequencyType = 'variable',
      consistentFrequency,
      audioFiles,
      totalAudioDuration,
      imageAmount,
      audioDistributionType,
      audioFirstPageImageCount,
      audioRestImageCount,
    } = requestData;

    // Extract custom character fields with defaults
    const customCharactersEnabled = requestData.customCharactersEnabled ?? false;
    const customCharacters = requestData.customCharacters ?? [];
    const customCharactersAIEnhance = requestData.customCharactersAIEnhance ?? false;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Missing or invalid group_id');
    if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (file_path.includes('..') || file_path.startsWith('/')) throw new Error('Invalid file_path: path traversal not allowed');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');
    if (!style || typeof style !== 'string') throw new Error('Missing or invalid style');
    if (typeof useCharacterDescriptions !== 'boolean') throw new Error('Missing or invalid useCharacterDescriptions');
    
    // Validate frequency based on mode and type
    if (frequencyMode === 'wordcount' && frequencyType === 'consistent') {
      // Consistent mode: firstPageFrequency should be NULL, use restFrequency for all
      if (firstPageFrequency !== null) {
        console.warn('[SETUP] Consistent mode detected but firstPageFrequency is not NULL, setting to NULL');
      }
      if (typeof restFrequency !== 'number' || restFrequency < 5 || restFrequency > 300) {
        throw new Error('Invalid restFrequency (must be 5–300)');
      }
    } else if (frequencyMode === 'wordcount') {
      // Variable mode: validate both frequencies
      if (typeof firstPageFrequency !== 'number' || firstPageFrequency < 5 || firstPageFrequency > 120) {
        throw new Error('Invalid firstPageFrequency (must be 5–120)');
      }
      if (typeof restFrequency !== 'number' || restFrequency < 5 || restFrequency > 300) {
        throw new Error('Invalid restFrequency (must be 5–300)');
      }
    }
    // Audio mode validation would go here if needed
    
    if (typeof variant !== 'number') throw new Error('Missing or invalid variant');

    // Server-side token balance: fetch from DB instead of trusting client-provided value
    const PLAN_MAX_TOKENS: Record<string, number> = {
      free: 400000, standard: 4000000, plus: 6000000, premium: 10000000,
      pro: 25000000, elite: 50000000, ultimate: 75000000, enterprise: 250000000,
    };
    const { data: _planData, error: _planError } = await supabase
      .from('user_plans')
      .select('tokens_used, plan_type, rollover_tokens')
      .eq('user_id', user_id)
      .maybeSingle();
    if (_planError || !_planData) {
      throw new Error('Could not fetch user token balance from database');
    }
    const _planType = _planData.plan_type ?? 'free';
    const _planMax = PLAN_MAX_TOKENS[_planType] ?? 400000;
    const _rolloverTokens = _planData.rollover_tokens ?? 0;
    const userTokenBalance = Math.max(0, _planMax + _rolloverTokens - (_planData.tokens_used ?? 0));

    // Validate language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language || '') ? language : 'english';

    // Validate model
    const supportedModels = ['deepseek', 'sonnet', 'opus'];
    const validatedModel = supportedModels.includes(model || '') ? model : 'sonnet';

    // Validate processImage
    const shouldProcessImage = processImage === true;

    const imageModel = requestData.imageModel || 'plus';
    // Validate with frontend and backend values
    if (!['standard', 'plus', 'premium', 'spark', 'grok', 'prime', 'genesis', 'imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'].includes(imageModel)) {
      throw new Error('Invalid imageModel');
    }

    // Map to backend model after validation
    const backendImageModel = getBackendImageModel(imageModel);

    // Check for existing processes with same group_id, user_id, tab and find if requested variant exists
    // This prevents conflicts when multiple processes run on the same document
    
    // Query image_prompt_tasks for existing variants (no version filter to see all variants)
    const { data: existingTasks, error: tasksError } = await supabase
      .from('image_prompt_tasks')
      .select('variant')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('tab', tab);
    
    if (tasksError) {
      console.warn(`Warning: Could not check existing tasks: ${tasksError.message}`);
    }
    
    // Collect all existing variants from image_prompt_tasks only
    const existingVariants = new Set<number>();
    if (existingTasks && existingTasks.length > 0) {
      existingTasks.forEach(t => {
        if (t.variant !== null && t.variant !== undefined) {
          existingVariants.add(t.variant);
        }
      });
    }
    
    // Determine final variant: use requested variant if available, otherwise find next available
    let finalVariant = variant;
    if (existingVariants.has(variant)) {
      // Requested variant exists, find highest and increment
      const highestVariant = Math.max(...Array.from(existingVariants));
      finalVariant = highestVariant + 1;
    }
    
    console.log(`Variant check: requested=${variant}, existing_variants=[${Array.from(existingVariants).sort().join(', ')}], using=${finalVariant}`);

    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('is_corrected')
      .eq('id', doc_id)
      .single();
    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);
    const is_corrected = docData.is_corrected;

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(file_path);
    if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);
    const content = await fileData.text();
    if (!content || content.length === 0) throw new Error('Document content is empty');

    if (content.length > 900000) {
      throw new Error("Input text too large for processing");
    }

    // Store full story context in image_prompt_context table
    const cleanedText = cleanTextForPrompts(content);
    const wordCount = calculateWordCount(cleanedText);
    const characterCount = cleanedText.length;

    console.log(`Storing context for group_id: ${group_id}, words: ${wordCount}, chars: ${characterCount}`);
    
    const textParts = splitTextIfLarge(content);
    console.log(`Split text into ${textParts.length} parts, sizes: ${textParts.map(p => calculateWordCount(p)).join(', ')} words`);
    
    // Store each text part as a separate row in image_prompt_context
    for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
      const partText = textParts[partIdx];
      const partWordCount = calculateWordCount(partText);
      const partCharCount = partText.length;
      const partNumber = partIdx + 1;
      
      console.log(`Storing part ${partNumber}/${textParts.length}: ${partWordCount} words, ${partCharCount} chars`);
      
      const { error: contextError } = await supabase
        .from('image_prompt_context')
        .upsert({
          group_id: group_id,
          part_number: partNumber,
          user_id: user_id,
          tab: tab,
          video_process: videoProcess || null,
          process_image: shouldProcessImage,
          full_story_text: partText,
          word_count: partWordCount,
          character_count: partCharCount,
          master_prompt_data: masterPromptData || null,
          environment_only_mode: environmentOnlyMode,
          style_description: style,
          character_descriptions: null, // Will be filled after extraction
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, {
          onConflict: 'group_id,part_number'
        });

      if (contextError) {
        console.error(`Failed to store part ${partNumber}: ${contextError.message}`);
        throw new Error(`Failed to store context part ${partNumber}`);
      }
      
      console.log(`Successfully stored part ${partNumber} for group_id: ${group_id}`);
    }
    let characters: Record<string, string> = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    if (useCharacterDescriptions) {
      if (customCharactersEnabled && customCharacters.length > 0) {
        // Custom characters path: user provided their own character descriptions
        const validCustomChars = customCharacters.filter((c: any) => c.name && c.name.trim());
        
        if (validCustomChars.length > 0) {
          if (customCharactersAIEnhance) {
            // AI Enhancement: expand basic descriptions into detailed visual descriptions
            console.log(`Enhancing ${validCustomChars.length} custom characters with AI...`);
            const { enhanced, inputTokens, outputTokens } = await enhanceCustomCharacterDescriptions(
              validCustomChars,
              story_title,
              style
            );
            characters = enhanced;
            totalInputTokens += inputTokens;
            totalOutputTokens += outputTokens;
            console.log(`AI-enhanced ${Object.keys(characters).length} custom characters`);
          } else {
            // No AI enhancement: convert array to Record<string, string> directly
            console.log(`Using ${validCustomChars.length} custom characters without AI enhancement`);
            for (const char of validCustomChars) {
              characters[char.name.trim()] = char.description || 'A character in the story.';
            }
          }
        } else {
          console.log('Custom characters enabled but none have names, falling back to extraction');
          const { characters: extracted, inputTokens, outputTokens } = await extractCharacterDescriptions(content);
          characters = extracted;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
        }
      } else {
        // Default path: auto-extract from story text
        const { characters: extracted, inputTokens, outputTokens } = await extractCharacterDescriptions(content);
        characters = extracted;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
      }

      // Check if custom character names appear in the story text
      // Only true when custom characters are enabled AND their names are found in the story
      let customCharsInStory = false;
      if (customCharactersEnabled && Object.keys(characters).length > 0) {
        const storyLower = content.toLowerCase();
        const matchedNames = Object.keys(characters).filter(name => storyLower.includes(name.toLowerCase().trim()));
        if (matchedNames.length === 0) {
          customCharsInStory = false;
          console.log(`⚠️ None of the custom character names were found in the story text. All characters will be appended to every prompt as fallback.`);
        } else {
          console.log(`✓ Found ${matchedNames.length} of ${Object.keys(characters).length} character name(s) in story: ${matchedNames.join(', ')}`);
        }
      }

      // Update all parts with character descriptions and custom_chars_in_story flag
      for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
        await supabase
          .from('image_prompt_context')
          .update({
            character_descriptions: characters,
            custom_chars_in_story: customCharsInStory,
            updated_at: new Date().toISOString(),
          })
          .eq('group_id', group_id)
          .eq('part_number', partIdx + 1);
      }
    }

    let totalPrompts = 0;
    let totalBatches = 0;
    let charPosition = 0;
    
    // For consistent frequency mode, use restFrequency for both first page and rest
    const effectiveFirstPageFreq = (frequencyMode === 'wordcount' && frequencyType === 'consistent') 
      ? restFrequency 
      : (firstPageFrequency || restFrequency);
    
    for (let partIdx = 0; partIdx < textParts.length; partIdx++) {
      const partText = textParts[partIdx];
      const partNumber = partIdx + 1;
      let segments: Segment[];
      
      if (frequencyMode === 'audio') {
        // Audio-based segmentation using image counts
        console.log(`Using audio-based segmentation mode: ${audioDistributionType}`);
        
        if (audioDistributionType === 'consistent') {
          // Consistent: use imageAmount for total, distributed evenly
          const totalImages = imageAmount || 10;
          console.log(`  Consistent distribution: ${totalImages} total images (exact count, no adjustments)`);
          
          // No retry logic for audio mode - create exactly the requested number
          segments = createAudioBasedSegments(partText, totalImages, null, 'consistent');
          console.log(`  Created exactly ${segments.length} segments as requested`);
        } else {
          // Variable: use audioFirstPageImageCount and audioRestImageCount
          const firstPageCount = audioFirstPageImageCount || 5;
          const restCount = audioRestImageCount || 5;
          const totalCount = firstPageCount + restCount;
          console.log(`  Variable distribution: ${firstPageCount} first page + ${restCount} rest = ${totalCount} total images (exact count, no adjustments)`);
          
          // No retry logic for audio mode - create exactly the requested number
          segments = createAudioBasedSegments(partText, totalCount, firstPageCount, 'variable');
          console.log(`  Created exactly ${segments.length} segments as requested`);
        }
      } else {
        // Word count based segmentation
        if (frequencyType === 'consistent') {
          // Consistent mode: use chapter-aware segmentation with same frequency for both first page and rest
          // This matches Python's behavior where consistent mode still uses segment_text() 
          // but with both frequencies set to the same value
          console.log(`Word count consistent mode: using ${restFrequency}s frequency for entire story (chapter-aware)`);
          
          segments = segmentText(partText, restFrequency, restFrequency, charPosition, validatedModel);
        } else {
          // Variable mode: use time-based segmentation with first page distinction
          segments = segmentText(partText, effectiveFirstPageFreq, restFrequency, charPosition, validatedModel);
        }
      }
      
      // Skip empty segments arrays (from text parts that were too small)
      if (segments.length === 0) {
        console.log("Skipping empty segments array from small text part");
        charPosition += partText.length;
        continue;
      }
      
      // Final validation check - segments should be valid after retries
      const totalWords = calculateWordCount(partText);
      if (!validateSegmentLength(segments, totalWords)) {
        console.warn('Some segments are still too short after retries, but proceeding with generation');
      }
      
      totalPrompts += segments.length;
      const [batchCount] = determineBatchCount(segments, restFrequency, validatedModel);
      totalBatches += batchCount;
      charPosition += partText.length;
    }

    const estimatedTokens = Math.round(totalInputTokens * 0.25 + totalOutputTokens);

    const taskIds = Array.from({ length: totalBatches }, () => crypto.randomUUID());
    const jobId = crypto.randomUUID();

    // Create array of part numbers as strings instead of full text
    const textPartNumbers = textParts.map((_, idx) => String(idx + 1));

    const { error: jobError } = await supabase
      .from('job_data')
      .insert({
        id: jobId,
        user_id,
        data: {
          textParts: textPartNumbers,
          user_id,
          group_id,
          file_path,
          story_title,
          description,
          style,
          useCharacterDescriptions,
          firstPageFrequency: effectiveFirstPageFreq, // Use effective frequency (restFrequency for consistent mode)
          restFrequency,
          variant: finalVariant, // Use the calculated variant
          doc_id,
          characters,
          totalInputTokens,
          totalOutputTokens,
          is_corrected,
          taskIds,
          totalPrompts,
          totalBatches,
          userTokenBalance,
          imageModel: backendImageModel,
          videoProcess,
          language: validatedLanguage,
          model: validatedModel,
          processImage: shouldProcessImage,
          tab: tab, // Include tab in job data
          masterPromptData: masterPromptData || null, // Include master prompt
          environmentOnlyMode: environmentOnlyMode, // Include environment mode
          frequencyMode: frequencyMode || 'wordcount',
          frequencyType: frequencyType || 'variable',
          audioDistributionType: audioDistributionType || null,
          imageAmount: imageAmount || null,
          audioFirstPageImageCount: audioFirstPageImageCount || null,
          audioRestImageCount: audioRestImageCount || null,
          customCharactersEnabled,
          customCharactersAIEnhance,
        },
      });
    if (jobError) throw new Error(`Failed to insert job data: ${jobError.message}`);
    console.log(`Inserted job data for jobId: ${jobId}, user_id: ${user_id}, totalBatches: ${totalBatches}, videoProcess: ${videoProcess}, language: ${validatedLanguage}, model: ${validatedModel}, processImage: ${shouldProcessImage}, tab: ${tab}`);

    try {
      const response = await fetchWithDenoFallback('storyscriptai-process-task', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': Deno.env.get("SECRET_KEY"),
        },
        body: JSON.stringify({ jobId, user_id }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to trigger process-task: HTTP ${response.status} - ${errorText}`);
        throw new Error(`Failed to trigger process-task: HTTP ${response.status} - ${errorText}`);
      }
      console.log(`Successfully triggered process-task for jobId: ${jobId}`);
    } catch (error: any) {
      console.error(`Trigger error: ${error.message}`);
      await supabase.from('job_data').delete().eq('id', jobId);
      throw new Error(`Failed to trigger process-task: ${error.message}`);
    }

    // If this is part of a video process, update video task status
    if (videoProcess) {
      try {
        await supabase
          .from('video_tasks')
          .update({
            image_prompt_status: 'running',
            image_prompt_progress: 10,
            overall_progress: 30,
            // Store the exact image count so the polling UI has an accurate number
            // for time estimates before batch rows are created (mirrors TTV/ITV behaviour).
            image_amount: totalPrompts,
            updated_at: new Date().toISOString()
          })
          .eq('group_id', group_id)
          .eq('user_id', user_id)
          .eq('is_main', true); // Only update the main task row, not batch sub-rows
        
        console.log(`Updated video task status for image prompt generation`);
      } catch (error: any) {
        console.error(`Failed to update video task status: ${error.message}`);
      }
    }

    return new Response(JSON.stringify({
      task_ids: taskIds,
      total_batches: totalBatches,
      total_prompts: totalPrompts,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      language: validatedLanguage,
      model: validatedModel,
      tab: tab, // Return tab in response
    }), {
      status: 200,
      headers: { // Return validated model
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (error: any) {
    console.error(`Error in setup-prompt: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }
});



