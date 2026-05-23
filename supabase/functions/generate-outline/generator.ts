import { OpenAI } from 'npm:openai@4';

const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY');
if (!DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is not set in environment variables');
}
const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

// Constants
const TOKEN_PER_WORD = 1.33;
const MAX_WORDS_PER_BATCH = 500;

// Interfaces
export interface Chapter {
  index: number;
  title: string;
  part: string;
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

// Utility Functions
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(word => word.length > 0).length;
  return Math.ceil(words * TOKEN_PER_WORD);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

export async function writeBatch(
  batch: Chapter[],
  previousContent: string,
  totalWordCount: number,
  checkCancellation: () => boolean,
  retries = 3,
  delay = 5
): Promise<[string, number, number]> {
  if (checkCancellation()) {
    throw new Error('Task cancelled');
  }

  const batchWordCount = batch.reduce((sum, ch) => sum + ch.word_count, 0);
  if (batchWordCount > MAX_WORDS_PER_BATCH) {
    throw new Error(`Batch word count exceeds ${MAX_WORDS_PER_BATCH} words: ${batchWordCount}`);
  }

  const systemPrompt = `You are a creative writer. Write the content for the given chapters or chapter parts based on the outline, ensuring:
- Aim for approximately the target word count for each chapter or part, totaling ${batchWordCount} words for this batch.
- The total word count across all chapters should contribute to ${totalWordCount} words for the full story.
- Maintain perfect continuity with the previous content provided.
- Use a consistent style and voice throughout.
- Include natural transitions between chapters or parts.
- Incorporate engaging dialogue and vivid descriptions.
- Keep the total context, including previous content, under 48,000 words (~64,000 tokens).
- For each chapter or part, include a heading in the format **Chapter X: Chapter Title** or **Chapter X: Chapter Title (Part Y)** (where X is the chapter number, Chapter Title is the title from the outline, and Part Y is the part identifier if applicable), followed by the chapter content.
Provide the story text for the chapters or parts in this batch, with the specified headings.`;

  const chaptersOutline = batch.map(c => ({
    number: c.index,
    title: c.title,
    part: c.part,
    summary: c.summary,
    word_count: c.word_count,
  }));
  const userPrompt = `Write the following chapters or parts:\n${JSON.stringify(chaptersOutline, null, 2)}\nPrevious content:\n${previousContent}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (checkCancellation()) {
      throw new Error('Task cancelled');
    }
    try {
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8000,
        temperature: 1.1,
        stream: false,
      });
      const batchContent = completion.choices[0].message.content || '';
      const inputTokens = completion.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
      const outputTokens = completion.usage?.completion_tokens || estimateTokens(batchContent);
      console.log(`Batch written: ${batch.length} chapters/parts, ${countWords(batchContent)} words.`);
      return [batchContent, inputTokens, outputTokens];
    } catch (error: any) {
      const errorStr = String(error);
      if (['429', '500', '503'].some(code => errorStr.includes(code)) || errorStr.toLowerCase().includes('overloaded')) {
        if (attempt < retries - 1) {
          console.log(`Transient error occurred: ${errorStr}. Retrying in ${delay} seconds... (Attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          continue;
        }
        throw new Error(`Failed to write batch after ${retries} attempts due to server issues: ${errorStr}. Please try again later.`);
      }
      throw error;
    }
  }
  throw new Error('Unexpected error in writeBatch');
}

export async function rewriteBatch(
  batch: Chapter[],
  previousContent: string,
  feedback: string,
  outline: string,
  storyTitle: string,
  description: string,
  totalWordCount: number,
  checkCancellation: () => boolean,
  retries = 3,
  delay = 5
): Promise<[string, number, number]> {
  if (checkCancellation()) {
    throw new Error('Task cancelled');
  }

  const batchWordCount = batch.reduce((sum, ch) => sum + ch.word_count, 0);
  if (batchWordCount > MAX_WORDS_PER_BATCH) {
    throw new Error(`Batch word count exceeds ${MAX_WORDS_PER_BATCH} words: ${batchWordCount}`);
  }

  const systemPrompt = `You are a creative writer. Write a new version of the story for the given chapters or chapter parts based on the outline, using the provided feedback to guide your writing. Ensure:
- Follow the feedback to maintain the tone, themes, plot points, character consistency, and specific details.
- Aim for approximately the target word count for each chapter or part, totaling ${batchWordCount} words for this batch.
- The total word count across all chapters should contribute to ${totalWordCount} words for the full story.
- Maintain perfect continuity with the previous content provided.
- Use a consistent style and voice throughout.
- Include natural transitions between chapters or parts.
- Incorporate engaging dialogue and vivid descriptions.
- Keep the total context, including previous content, under 48,000 words (~64,000 tokens).
- For each chapter or part, include a heading in the format **Chapter X: Chapter Title** or **Chapter X: Chapter Title (Part Y)** (where X is the chapter number, Chapter Title is the title from the outline, and Part Y is the part identifier if applicable), followed by the chapter content.
Provide the story text for the chapters or parts in this batch, with the specified headings. Do not include any additional commentary, explanations, notes, or sections in the output.`;

  const chaptersOutline = batch.map(c => ({
    number: c.index,
    title: c.title,
    part: c.part,
    summary: c.summary,
    word_count: c.word_count,
  }));
  const userPrompt = `Write a new version of the following chapters or parts based on this outline:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nUse this feedback to guide your writing:\n${feedback}\n\nPrevious content (for continuity):\n${previousContent}`;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (checkCancellation()) {
      throw new Error('Task cancelled');
    }
    try {
      const completion = await openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 8000,
        temperature: 1.0,
        stream: false,
      });
      const batchContent = completion.choices[0].message.content || '';
      const inputTokens = completion.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
      const outputTokens = completion.usage?.completion_tokens || estimateTokens(batchContent);
      console.log(`Batch rewritten: ${batch.length} chapters/parts, ${countWords(batchContent)} words.`);
      return [batchContent, inputTokens, outputTokens];
    } catch (error: any) {
      const errorStr = String(error);
      if (['429', '500', '503'].some(code => errorStr.includes(code)) || errorStr.toLowerCase().includes('overloaded')) {
        if (attempt < retries - 1) {
          console.log(`Transient error occurred: ${errorStr}. Retrying in ${delay} seconds... (Attempt ${attempt + 1}/${retries})`);
          await new Promise(resolve => setTimeout(resolve, delay * 1000));
          continue;
        }
        throw new Error(`Failed to rewrite batch after ${retries} attempts due to server issues: ${errorStr}. Please try again later.`);
      }
      throw error;
    }
  }
  throw new Error('Unexpected error in rewriteBatch');
}