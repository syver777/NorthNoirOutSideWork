import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import { createClient } from "@supabase/supabase-js";
import { checkNetworkStatus } from './shared';
import { llmMultiplier } from '../data/tokenCosts';

// Initialize Supabase client
const SUPABASE_URL: string = import.meta.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY: string = import.meta.env.SUPABASE_PUBLISHABLE_KEY;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY is not set in environment variables');
}
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

// Constants
const TOKEN_PER_WORD: number = 1.33;
const INPUT_CREDIT_PER_MILLION_TOKENS: number = 0.27;
const OUTPUT_CREDIT_PER_MILLION_TOKENS: number = 1.10;
const EDGE_FUNCTION_TIMEOUT: number = 3600000; // 360 seconds timeout
const MAX_RETRIES: number = 5;
const INITIAL_RETRY_DELAY: number = 2000; // Start with 2 seconds
const MAX_WORDS_PER_BATCH: number = 500;
const MIN_CHAPTERS_SHORT: number = 2; // For stories < 3000 words

// Model batching configuration. Multipliers live in src/data/tokenCosts.ts
// (legacy vs new) — resolve them via llmMultiplier(isLegacy, model).
const MODEL_BATCH_WORDS: Record<string, number> = {
  deepseek: 1100,
  sonnet:   3000,
  opus:     3000,
};
function maxWordsForModel(model: string): number {
  return MODEL_BATCH_WORDS[model] ?? 1100;
}

// Interfaces
export interface Chapter {
  index: number;
  number?: number;
  part?: string | null;
  title: string;
  word_count: number;
  summary: string;
  original_line?: string;
  group_id?: string;
}

export interface Batch {
  batch_number: number;
  chapter_identifiers: string[];
  total_words: number;
  group_id?: string;
}

export interface ComparisonResult {
  doc1Review: {
    pacing: { rating: number; text: string };
    consistency: { rating: number; text: string };
    characterDevelopment: { rating: number; text: string };
    plotCoherence: { rating: number; text: string };
    toneAndAtmosphere: { rating: number; text: string };
    overallQuality: string;
  };
  doc2Review: {
    pacing: { rating: number; text: string };
    consistency: { rating: number; text: string };
    characterDevelopment: { rating: number; text: string };
    plotCoherence: { rating: number; text: string };
    toneAndAtmosphere: { rating: number; text: string };
    overallQuality: string;
  };
  doc1Rating: number;
  doc2Rating: number;
  doc1WordCount: number;
  doc2WordCount: number;
  summary: string;
}

// Utility to count words
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Estimate tokens from text
function estimateTokens(text: string | number): number {
  if (typeof text === 'number') {
    return Math.ceil(text * TOKEN_PER_WORD);
  }
  return Math.ceil(countWords(text) * TOKEN_PER_WORD);
}

// Resolve the LLM token multiplier for a model under the active plan.
// Defaults to legacy rates if the caller didn't pass `isLegacy` (safer:
// grandfathered users see the same numbers they always have).
function getTokenMultiplier(model: string, isLegacy: boolean = true): number {
  return llmMultiplier(isLegacy, model);
}

// Process a single story batch
async function processStoryBatches(
  chapters: Chapter[],
  total_word_count: number,
  group_id: string,
  user_id: string,
  title: string,
  batch: Batch,
  shouldStop: () => boolean,
  model: string = 'sonnet',
  tab: number = 1,
  isLegacy: boolean = true
): Promise<void> {
  if (!checkNetworkStatus()) {
    throw new Error('No internet connection. Please check your network and try again.');
  }
  if (shouldStop()) {
    throw new Error('Story generation stopped by user');
  }

  const { batch_number: batchNumber, chapter_identifiers: chapterIdentifiers, total_words: totalWords } = batch;
  console.log(`Processing batch ${batchNumber} for chapters: ${chapterIdentifiers}`);

  let retries = 0;
  let delay: number = INITIAL_RETRY_DELAY;
  let batch_content: string = '';
  let input_tokens: number = 0;
  let output_tokens: number = 0;

  while (retries < MAX_RETRIES) {
    try {
      const { data: { session: _gSession } } = await supabase.auth.getSession();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/process-story`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_gSession?.access_token || ''}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          chapters,
          batch_number: batchNumber,
          chapter_identifiers: chapterIdentifiers,
          total_word_count: totalWords,
          group_id,
          user_id,
          total_batches: 1, // Single batch processing
          model,
        }),
        signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to process batch ${batchNumber}`);
      }

      const data: any = await response.json();
      batch_content = data.content;
      input_tokens = data.input_tokens || 5000;
      output_tokens = data.output_tokens || 5000;
      break;
    } catch (error: any) {
      retries++;
      if (retries >= MAX_RETRIES) {
        throw new Error(`Failed to process batch ${batchNumber} after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for batch ${batchNumber}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  // Apply token multiplier
  const tokenMultiplier = getTokenMultiplier(model, isLegacy);
  const adjustedInputTokens = Math.round(input_tokens * tokenMultiplier);
  const adjustedOutputTokens = Math.round(output_tokens * tokenMultiplier);

  // Append batch content to partial story in stories bucket
  const partialPath: string = `partial/${user_id}/${group_id}/batch_${batchNumber}.txt`;
  let existingContent: string = '';
  try {
    const { data } = await supabase.storage.from('stories').download(partialPath);
    if (data) {
      existingContent = await data.text();
    }
  } catch (err: any) {
    console.warn(`No existing partial content at ${partialPath}, starting new file`);
  }

  const updatedContent: string = existingContent ? existingContent + '\n\n' + batch_content : batch_content;
  const file: File = new File([updatedContent], `batch_${batchNumber}.txt`, { type: 'text/plain' });
  const { error: uploadError } = await supabase.storage
    .from('stories')
    .upload(partialPath, file, { upsert: true });

  if (uploadError) {
    throw new Error(`Failed to upload partial story: ${uploadError.message}`);
  }

  // Update story_tasks
  const percentageComplete: number = 100; // Single batch completion
  const { error: taskError } = await supabase
    .from('story_tasks')
    .update({
      file_path: partialPath,
      status: 'completed',
      input_tokens: adjustedInputTokens,
      output_tokens: adjustedOutputTokens,
      progress: percentageComplete,
      updated_at: new Date().toISOString(),
    })
    .eq('group_id', group_id)
    .eq('batch_number', batchNumber)
    .eq('user_id', user_id)
    .eq('tab', tab);

  if (taskError) {
    throw new Error(`Failed to update story task for batch ${batchNumber}: ${taskError.message}`);
  }

  console.log(`Batch ${batchNumber} completed and saved to ${partialPath}`);
}

export async function generateFeedback(
  outline: string,
  groupId: string,
  shouldStop: () => boolean,
  model: string = 'sonnet',
  isLegacy: boolean = true
): Promise<[string, number, number]> {
  if (!checkNetworkStatus()) {
    throw new Error('No internet connection. Please check your network and try again.');
  }

  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;

  while (retries < MAX_RETRIES) {
    if (shouldStop()) {
      throw new Error('Feedback generation stopped by user');
    }

    try {
      const { data: { session: _gSession } } = await supabase.auth.getSession();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_gSession?.access_token || ''}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ outline, group_id: groupId, model }),
        signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const tokenMultiplier = getTokenMultiplier(model, isLegacy);
      const adjustedInputTokens = Math.round((data.inputTokens || 1200) * tokenMultiplier);
      const adjustedOutputTokens = Math.round((data.outputTokens || 1200) * tokenMultiplier);
      
      return [data.text, adjustedInputTokens, adjustedOutputTokens];
    } catch (error: any) {
      retries++;
      if (retries >= MAX_RETRIES) {
        throw new Error(`Failed to generate feedback after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for feedback generation: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error('Unexpected error in feedback generation');
}

export async function generateRewrite(
  groupId: string,
  shouldStop: () => boolean,
  model: string = 'sonnet',
  isLegacy: boolean = true
): Promise<[string, number, number]> {
  if (!checkNetworkStatus()) {
    throw new Error('No internet connection. Please check your network and try again.');
  }

  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;

  while (retries < MAX_RETRIES) {
    if (shouldStop()) {
      throw new Error('Story rewrite stopped by user');
    }

    try {
      const { data: { session: _gSession } } = await supabase.auth.getSession();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/generate-rewrite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_gSession?.access_token || ''}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ group_id: groupId, model }),
        signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: Failed to generate rewrite`);
      }

      const data = await response.json();
      const tokenMultiplier = getTokenMultiplier(model, isLegacy);
      const adjustedInputTokens = Math.round((data.inputTokens || 5000) * tokenMultiplier);
      const adjustedOutputTokens = Math.round((data.outputTokens || 5000) * tokenMultiplier);
      
      return [data.story, adjustedInputTokens, adjustedOutputTokens];
    } catch (error: any) {
      retries++;
      if (retries >= MAX_RETRIES) {
        throw new Error(`Failed to generate rewrite after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for story rewrite: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error('Unexpected error in story rewrite');
}

export async function compareStories(
  doc1: string,
  doc2: string,
  userId: string,
  groupId: string,
  shouldStop: () => boolean,
  model: string = 'sonnet',
  tab: number = 1,
  isLegacy: boolean = true
): Promise<[ComparisonResult, number, number]> {
  if (!checkNetworkStatus()) {
    throw new Error('No internet connection. Please check your network and try again.');
  }

  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;

  while (retries < MAX_RETRIES) {
    if (shouldStop()) {
      throw new Error('Story comparison stopped by user');
    }

    try {
      const { data: { session: _gSession } } = await supabase.auth.getSession();
      const response = await fetch(`${SUPABASE_URL}/functions/v1/compare-stories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${_gSession?.access_token || ''}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({
          original_story: doc1,
          corrected_story: doc2,
          user_id: userId,
          group_id: groupId,
          model,
          tab,
        }),
        signal: AbortSignal.timeout(EDGE_FUNCTION_TIMEOUT),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const tokenMultiplier = getTokenMultiplier(model, isLegacy);
      const adjustedInputTokens = Math.round((data.inputTokens || 1800) * tokenMultiplier);
      const adjustedOutputTokens = Math.round((data.outputTokens || 1800) * tokenMultiplier);
      
      return [parseComparisonResult(data.comparison), adjustedInputTokens, adjustedOutputTokens];
    } catch (error: any) {
      retries++;
      if (retries >= MAX_RETRIES) {
        throw new Error(`Failed to compare stories after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for story comparison: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error('Unexpected error in story comparison');
}

export async function performComparison(
  doc1: string,
  doc2: string,
  userId: string,
  groupId: string,
  shouldStop: () => boolean,
  model: string = 'sonnet',
  tab: number = 1,
  isLegacy: boolean = true
): Promise<[ComparisonResult, number, number]> {
  return compareStories(doc1, doc2, userId, groupId, shouldStop, model, tab, isLegacy);
}

export function parseComparisonResult(comparisonText: string): ComparisonResult {
  const lines = comparisonText.split('\n').filter(line => line.trim() !== '');
  const result: ComparisonResult = {
    doc1Review: {
      pacing: { rating: 0, text: '' },
      consistency: { rating: 0, text: '' },
      characterDevelopment: { rating: 0, text: '' },
      plotCoherence: { rating: 0, text: '' },
      toneAndAtmosphere: { rating: 0, text: '' },
      overallQuality: '',
    },
    doc2Review: {
      pacing: { rating: 0, text: '' },
      consistency: { rating: 0, text: '' },
      characterDevelopment: { rating: 0, text: '' },
      plotCoherence: { rating: 0, text: '' },
      toneAndAtmosphere: { rating: 0, text: '' },
      overallQuality: '',
    },
    doc1Rating: 0,
    doc2Rating: 0,
    doc1WordCount: 0,
    doc2WordCount: 0,
    summary: '',
  };

  let currentDoc: 'doc1' | 'doc2' | null = null;
  let currentCategory: string | null = null;

  // Map display category names to interface keys
  const categoryMap: { [key: string]: string } = {
    'Pacing': 'pacing',
    'Consistency': 'consistency',
    'Character Development': 'characterDevelopment',
    'Plot Coherence': 'plotCoherence',
    'Tone and Atmosphere': 'toneAndAtmosphere',
    'Overall Quality': 'overallQuality',
  };

  for (const line of lines) {
    if (line.includes('Document 1 Evaluation')) {
      currentDoc = 'doc1';
      continue;
    } else if (line.includes('Document 2 Evaluation')) {
      currentDoc = 'doc2';
      continue;
    } else if (line.startsWith('Summary')) {
      currentDoc = null;
      currentCategory = 'summary';
      continue;
    }

    if (currentDoc) {
      const ratingMatch = line.match(/(.+?):\s*(\d+\.?\d?)\/10\s*-\s*(.+)/);
      const overallMatch = line.match(/Overall Quality:\s*(.+)/);
      const wordCountMatch = line.match(/Word Count:\s*(\d+)/);
      const overallRatingMatch = line.match(/Overall Rating:\s*(\d+\.?\d?)\/10/);

      if (ratingMatch) {
        const [, category, rating, text] = ratingMatch;
        const trimmedCategory = category.trim();
        const key = categoryMap[trimmedCategory];
        if (key && key in result[`${currentDoc}Review`]) {
          result[`${currentDoc}Review`][key as keyof typeof result[`${currentDoc}Review`]] = { rating: parseFloat(rating), text: text.trim() };
          currentCategory = key;
        }
      } else if (overallMatch) {
        // Handle Overall Quality
        result[`${currentDoc}Review`].overallQuality = overallMatch[1].trim();
        currentCategory = 'overallQuality';
      } else if (wordCountMatch) {
        result[`${currentDoc}WordCount`] = parseInt(wordCountMatch[1]);
      } else if (overallRatingMatch) {
        result[`${currentDoc}Rating`] = parseFloat(overallRatingMatch[1]);
      }
    } else if (currentCategory === 'summary') {
      result.summary += (result.summary ? '\n' : '') + line.trim();
    }
  }

  // Validate required fields
  if (!result.doc1Review.pacing.text || !result.doc2Review.pacing.text) {
    throw new Error('Missing required fields in comparison result');
  }

  return result;
}

export async function createDocument(
  title: string,
  content: string
): Promise<Blob> {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.TITLE,
          }),
          ...content.split('\n').map(
            (line) =>
              new Paragraph({
                text: line,
              })
          ),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// Calculate credits from tokens
function calculateCredits(inputTokens: number, outputTokens: number): number {
  const inputCredits = (inputTokens / 1_000_000) * INPUT_CREDIT_PER_MILLION_TOKENS;
  const outputCredits = (outputTokens / 1_000_000) * OUTPUT_CREDIT_PER_MILLION_TOKENS;
  return inputCredits + outputCredits;
}

// Estimate credits for generating the story, including optional correction and comparison
export function estimateStoryCredits(
  wordCount: number, 
  includeCorrection: boolean = false, 
  includeComparison: boolean = false,
  model: string = 'sonnet',
  hasMasterPrompt: boolean = false,
  masterPromptEnhanceAI: boolean = false,
  isLegacy: boolean = true
): {
  totalCredits: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  breakdown: {
    outline: { inputTokens: number; outputTokens: number; credits: number };
    originalStory: { inputTokens: number; outputTokens: number; credits: number };
    feedback: { inputTokens: number; outputTokens: number; credits: number };
    correctedStory: { inputTokens: number; outputTokens: number; credits: number };
    comparison: { inputTokens: number; outputTokens: number; credits: number };
    totalCredits: number;
  }
} {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  
  const tokenMultiplier = getTokenMultiplier(model, isLegacy);
  const maxWordsPerBatch = maxWordsForModel(model);

  const breakdown: {
    outline: { inputTokens: number; outputTokens: number; credits: number };
    originalStory: { inputTokens: number; outputTokens: number; credits: number };
    feedback: { inputTokens: number; outputTokens: number; credits: number };
    correctedStory: { inputTokens: number; outputTokens: number; credits: number };
    comparison: { inputTokens: number; outputTokens: number; credits: number };
    totalCredits: number;
  } = {
    outline: { inputTokens: 0, outputTokens: 0, credits: 0 },
    originalStory: { inputTokens: 0, outputTokens: 0, credits: 0 },
    feedback: { inputTokens: 0, outputTokens: 0, credits: 0 },
    correctedStory: { inputTokens: 0, outputTokens: 0, credits: 0 },
    comparison: { inputTokens: 0, outputTokens: 0, credits: 0 },
    totalCredits: 0,
  };

  // Master prompt token overhead (estimate ~500 tokens for AI enhancement overhead)
  // Only applies when master prompt is enabled AND AI enhancement is on
  const masterPromptTokens = (hasMasterPrompt && masterPromptEnhanceAI) ? Math.round(500 * tokenMultiplier) : 0;

  // 1. Outline Generation
  const systemPromptWords = wordCount < 3000 ? 500 : 700;
  const userPromptWords = 5 + 50 + 10; // Title + description + word count instruction
  const outlineInputWords = systemPromptWords + userPromptWords;
  const outlineInputTokens = Math.round(estimateTokens(outlineInputWords) * tokenMultiplier) + masterPromptTokens;
  const numBatches = Math.ceil(wordCount / maxWordsPerBatch);
  const outlineOutputWords = numBatches * 100 + 50;
  const outlineOutputTokens = Math.round(estimateTokens(outlineOutputWords) * tokenMultiplier);
  breakdown.outline.inputTokens = outlineInputTokens;
  breakdown.outline.outputTokens = outlineOutputTokens;
  breakdown.outline.credits = calculateCredits(outlineInputTokens, outlineOutputTokens);
  totalInputTokens += outlineInputTokens;
  totalOutputTokens += outlineOutputTokens;

  // 2. Original Story Writing
  let batchInputTokens = 0;
  let batchTokens = 0;
  for (let i = 0; i < numBatches; i++) {
    const batchSystemPromptWords = 300;
    const chapterOutlineWords = 100;
    const previousContentWords = i * maxWordsPerBatch;
    const batchWords = batchSystemPromptWords + chapterOutlineWords + previousContentWords;
    batchInputTokens += Math.round(estimateTokens(batchWords) * tokenMultiplier);
    const batchWordsOutput = Math.min(wordCount - i * maxWordsPerBatch, maxWordsPerBatch);
    batchTokens += Math.round(estimateTokens(batchWordsOutput) * tokenMultiplier);
  }
  breakdown.originalStory.inputTokens = batchInputTokens;
  breakdown.originalStory.outputTokens = batchTokens;
  breakdown.originalStory.credits = calculateCredits(batchInputTokens, batchTokens);
  totalInputTokens += batchInputTokens;
  totalOutputTokens += batchTokens;

  if (includeCorrection) {
    // 3. Feedback Generation
    const feedbackSystemPromptWords = 360;
    const feedbackWords = feedbackSystemPromptWords + outlineOutputWords;
    const feedbackInputTokens = Math.round(estimateTokens(feedbackWords) * tokenMultiplier);
    const feedbackOutputWords = 500;
    const feedbackOutputTokens = Math.round(estimateTokens(feedbackOutputWords) * tokenMultiplier);
    breakdown.feedback.inputTokens = feedbackInputTokens;
    breakdown.feedback.outputTokens = feedbackOutputTokens;
    breakdown.feedback.credits = calculateCredits(feedbackInputTokens, feedbackOutputTokens);
    totalInputTokens += feedbackInputTokens;
    totalOutputTokens += feedbackOutputTokens;

    // 4. Corrected Story Writing
    let correctedBatchInputTokens = 0;
    let correctedBatchOutputTokens = 0;
    for (let i = 0; i < numBatches; i++) {
      const batchInputWords = 300 + 100 + 500 + (i * maxWordsPerBatch); // System + prompt + feedback + previous
      correctedBatchInputTokens += Math.round(estimateTokens(batchInputWords) * tokenMultiplier);
      const batchOutputWords = Math.min(wordCount - i * maxWordsPerBatch, maxWordsPerBatch);
      correctedBatchOutputTokens += Math.round(estimateTokens(batchOutputWords) * tokenMultiplier);
    }
    breakdown.correctedStory.inputTokens = correctedBatchInputTokens;
    breakdown.correctedStory.outputTokens = correctedBatchOutputTokens;
    breakdown.correctedStory.credits = calculateCredits(correctedBatchInputTokens, correctedBatchOutputTokens);
    totalInputTokens += correctedBatchInputTokens;
    totalOutputTokens += correctedBatchOutputTokens;

    if (includeComparison) {
      // 5. Comparison
      const comparisonSystemPromptWords = 100 * 3;
      const comparisonInputWords = comparisonSystemPromptWords + 7500 + 7500; // Original + corrected
      const comparisonInputTokens = Math.round(estimateTokens(comparisonInputWords) * tokenMultiplier);
      const comparisonOutputWords = 300 * 2 + 400;
      const comparisonOutputTokens = Math.round(estimateTokens(comparisonOutputWords) * tokenMultiplier);
      breakdown.comparison.inputTokens = comparisonInputTokens;
      breakdown.comparison.outputTokens = comparisonOutputTokens;
      breakdown.comparison.credits = calculateCredits(comparisonInputTokens, comparisonOutputTokens);
      totalInputTokens += comparisonInputTokens;
      totalOutputTokens += comparisonOutputTokens;
    }
  }

  breakdown.totalCredits = calculateCredits(totalInputTokens, totalOutputTokens);

  return {
    totalCredits: breakdown.totalCredits,
    totalInputTokens,
    totalOutputTokens,
    breakdown,
  };
}

// Check if user has sufficient credits
export function checkCredits(
  wordCount: number, 
  userCredits: number, 
  includeCorrection: boolean = false, 
  includeComparison: boolean = false,
  model: string = 'sonnet',
  hasMasterPrompt: boolean = false,
  masterPromptEnhanceAI: boolean = false,
  isLegacy: boolean = true
): {
  sufficient: boolean;
  requiredCredits: number;
  breakdown: any;
} {
  const estimation = estimateStoryCredits(wordCount, includeCorrection, includeComparison, model, hasMasterPrompt, masterPromptEnhanceAI, isLegacy);
  const sufficient = userCredits >= estimation.totalCredits;
  return {
    sufficient,
    requiredCredits: estimation.totalCredits,
    breakdown: estimation.breakdown,
  };
}

// Function to assign chapters to batches with improved identifier handling
export function assignChaptersToBatches(chapters: Chapter[], batches: Batch[]): Chapter[][] {
  const batchesArray: Chapter[][] = [];

  for (const batch of batches) {
    const batchChapters: Chapter[] = [];

    for (const identifier of batch.chapter_identifiers) {
      let chapterNum: number;
      let part: string | null = null;

      // Improved parsing of identifiers to handle different formats
      if (identifier.includes('Part')) {
        const [num, partStr] = identifier.split(' Part ');
        chapterNum = parseInt(num, 10);
        part = `Part ${partStr}`;
      } else {
        chapterNum = parseInt(identifier, 10);
      }

      // First try to find by exact number and part match
      let matchingChapter = chapters.find(ch =>
        ch.number === chapterNum &&
        (part === null ? !ch.part : ch.part === part)
      );

      // If not found, try to find by index as fallback
      if (!matchingChapter) {
        matchingChapter = chapters.find(ch =>
          ch.index === chapterNum - 1 &&
          (part === null ? !ch.part : ch.part === part)
        );
      }

      // If still not found, try more lenient matching
      if (!matchingChapter) {
        matchingChapter = chapters.find(ch => {
          // Match chapter by number only if parts aren't specified
          if (part === null && !ch.part && ch.number === chapterNum) {
            return true;
          }
          
          // Match chapter by number and partial part match
          if (part && ch.part && ch.number === chapterNum) {
            // Normalize part strings for comparison
            const normalizedPart = part.toLowerCase().replace(/\s+/g, '');
            const normalizedChPart = ch.part.toLowerCase().replace(/\s+/g, '');
            return normalizedPart === normalizedChPart;
          }
          
          return false;
        });
      }

      if (matchingChapter) {
        batchChapters.push(matchingChapter);
      } else {
        console.warn(`No chapter found for identifier: ${identifier} in batch ${batch.batch_number}`, {
          chapterNum,
          part,
          availableChapters: chapters.map(ch => ({
            index: ch.index,
            number: ch.number,
            part: ch.part,
            title: ch.title
          }))
        });
      }
    }

    batchesArray.push(batchChapters);
  }

  return batchesArray;
}


