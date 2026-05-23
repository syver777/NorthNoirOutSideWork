// Token estimation for video story generation with master prompt support

import { llmMultiplier } from '../data/tokenCosts';

const STORY_TOKENS_PER_WORD = 1.33;
const OUTLINE_TOKENS = 1500;
const MASTER_PROMPT_AI_OVERHEAD = 500; // Only when AI enhancement is ON

const MODEL_BATCH_WORDS: Record<string, number> = {
  deepseek: 1100,
  sonnet:   3000,
  opus:     3000,
};

/**
 * Estimate tokens for video story generation including master prompt overhead.
 * `isLegacy` selects the LEGACY vs NEW LLM multiplier map (defaults to legacy
 * so grandfathered users keep their existing rates if the flag isn't passed).
 */
export function estimateStoryTokensForVideo(
  wordCount: number,
  model: string = 'sonnet',
  hasMasterPrompt: boolean = false,
  masterPromptEnhanceAI: boolean = false,
  isLegacy: boolean = true,
): number {
  if (!wordCount || wordCount <= 0) return 0;

  const tokenMultiplier = llmMultiplier(isLegacy, model);
  const maxWordsPerBatch = MODEL_BATCH_WORDS[model] ?? MODEL_BATCH_WORDS.sonnet;
  const batchCount = Math.ceil(wordCount / maxWordsPerBatch);

  // Outline tokens
  const outlineTokens = Math.round(OUTLINE_TOKENS * tokenMultiplier);

  // Story generation tokens (simplified estimation)
  const avgWordsPerBatch = wordCount / batchCount;
  let totalInputTokens = 0;

  for (let i = 0; i < batchCount; i++) {
    const previousWords = i * avgWordsPerBatch;
    const previousTokens = previousWords * STORY_TOKENS_PER_WORD;
    totalInputTokens += 300 + 200 + previousTokens; // System prompt + outline + previous content
  }

  const outputTokens = wordCount * STORY_TOKENS_PER_WORD;
  const storyTokens = Math.round((totalInputTokens * 0.25 + outputTokens) * tokenMultiplier);

  // Master prompt overhead - ONLY when both flags are true
  const masterPromptTokens = (hasMasterPrompt && masterPromptEnhanceAI)
    ? Math.round(MASTER_PROMPT_AI_OVERHEAD * tokenMultiplier)
    : 0;

  return outlineTokens + storyTokens + masterPromptTokens;
}
