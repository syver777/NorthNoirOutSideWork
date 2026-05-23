
import OpenAI from "https://esm.sh/openai@4.57.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN_PER_WORD: number = 1.33;
const OUTLINE_TOKENS: number = 1500;
const FEEDBACK_TOKENS: number = 1200;
const STORY_TOKENS_PER_WORD: number = 1.33;
const MAX_RETRIES: number = 10;
const INITIAL_RETRY_DELAY: number = 1000;
const MIN_CHAPTERS_SHORT: number = 2;
const PARSE_RETRY_ATTEMPTS: number = 3;
const PARSE_RETRY_DELAY: number = 2000;
const REQUEST_TIMEOUT = 600000; // 10 minutes
const DEEPSEEK_TIMEOUT = 420000; // 7 minutes for DeepSeek API calls

// Self-retry: when the outline call fails (timeout, hung isolate, AI error, parse
// failure, anything) the handler fires a fresh HTTP POST to itself with
// _retryAttempt incremented. After MAX_SELF_RETRIES total attempts (0..4) the
// 5th invocation logs and exits silently without writing an error status to the
// database. No error_message is ever written by this retry path.
const MAX_SELF_RETRIES = 5;
const SELF_FUNCTION_URL = Deno.env.get('OUTLINE_FUNCTION_URL') || 'https://storyscriptai-outline.storyscriptai.deno.net/';

// Circuit breaker configuration
const CIRCUIT_BREAKER_STATE = {
  deepseek: { failures: 0, lastFailure: 0, isOpen: false },
  sonnet: { failures: 0, lastFailure: 0, isOpen: false },
  opus: { failures: 0, lastFailure: 0, isOpen: false }
};

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_TIMEOUT = 300000; // 5 minutes

// Language-specific word patterns - moved to global scope
const WORD_PATTERNS = {
  english: 'words',
  german: 'Wörter',
  spanish: 'palabras',
  french: 'mots'
};

// Model configurations
const MODEL_CONFIGS = {
  deepseek: {
    maxWordsPerBatch: 1100,
    apiKey: Deno.env.get("DEEPSEEK_API_KEY"),
    baseURL: "https://api.deepseek.com/v1",
    tokenMultiplier: 1.0,
    timeout: 420000 // 7 minutes
  },
  sonnet: {
    maxWordsPerBatch: 3000, // Updated from 3500 to 3000
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    baseURL: "https://api.anthropic.com",
    tokenMultiplier: 11.0,
    // Capped at 3 min so a hung Anthropic call still throws a catchable error
    // well before Deno Deploy recycles the isolate (which previously left the
    // task stuck in `processing` forever with no log line after "Attempt 1").
    timeout: 180000
  },
  opus: {
    maxWordsPerBatch: 3000, // Updated from 3500 to 3000
    apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    baseURL: "https://api.anthropic.com",
    tokenMultiplier: 19.0,
    timeout: 180000
  }
};

interface Chapter {
  index: number;
  logical_number: number;
  title: string;
  part: string | null;
  word_count: number;
  summary: string;
  original_line: string;
}

interface Batch {
  batch_number: number;
  chapter_identifiers: string[];
  total_words: number;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function estimateTokens(text: string | number): number {
  if (typeof text === "number") {
    return Math.ceil(text * TOKEN_PER_WORD);
  }
  return Math.ceil(countWords(text) * TOKEN_PER_WORD);
}

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]?.tokenMultiplier || 1.0;
}

function calculateEstimatedTokens(
  wordCount: number,
  model: string,
  includeCorrectedVersion: boolean = false,
  isLegacy: boolean = true,
): number {
  const modelMultiplier = llmMultiplier(isLegacy, model);
  
  const outlineTokens = OUTLINE_TOKENS * modelMultiplier;
  const storyGenerationTokens = Math.ceil(wordCount * STORY_TOKENS_PER_WORD * modelMultiplier);
  const correctionTokens = includeCorrectedVersion
    ? Math.ceil((FEEDBACK_TOKENS + (wordCount * STORY_TOKENS_PER_WORD)) * modelMultiplier)
    : 0;
  
  const totalTokens = outlineTokens + storyGenerationTokens + correctionTokens;
  
  return totalTokens;
}

function calculateTokensUsed(inputTokens: number, outputTokens: number): number {
  return inputTokens * 0.25 + outputTokens;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_PUBLIC_KEY = Deno.env.get("SUPABASE_PUBLIC_KEY");
const SUPABASE_SECRET_KEY = Deno.env.get("SUPABASE_SECRET_KEY") || '';
const PARSE_FUNCTION_URL = Deno.env.get("PARSE_FUNCTION_URL") || "https://storyscriptai-parse.storyscriptai.deno.net";

// Log at module load so cold-starts are visible in Deno Deploy logs.
// Previously we threw at the module top level when env was missing, which
// killed the isolate before any log line was emitted and caused the caller
// to see a bare 500 with nothing in the dashboard.
console.log(
  `[storyscriptai-outline] boot env check: SUPABASE_URL=${SUPABASE_URL ? 'set' : 'MISSING'}, SUPABASE_PUBLIC_KEY=${SUPABASE_PUBLIC_KEY ? 'set' : 'MISSING'}, SUPABASE_SECRET_KEY=${SUPABASE_SECRET_KEY ? 'set' : 'MISSING'}`,
);

const ENV_BOOT_ERROR: string | null =
  !SUPABASE_URL || !SUPABASE_PUBLIC_KEY
    ? "SUPABASE_URL or SUPABASE_PUBLIC_KEY is not set in environment variables"
    : null;

if (ENV_BOOT_ERROR) {
  console.error(`[storyscriptai-outline] boot error: ${ENV_BOOT_ERROR}`);
}

const supabase = SUPABASE_URL && SUPABASE_PUBLIC_KEY
  ? createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY)
  // Stub client whose calls fail loudly rather than crashing the module.
  // The request handler returns a 500 with ENV_BOOT_ERROR before any call
  // reaches this client in practice.
  : (createClient('http://invalid.local', 'invalid') as ReturnType<typeof createClient>);

// ── LLM token-cost branching: legacy vs new pricing ─────────────────────────
// Mirrors supabase/functions/_shared/tokenCosts.ts. Inlined here because Deno
// Deploy workers cannot import from the supabase functions tree.
const LEGACY_LLM_MULTIPLIERS: Record<string, number> = {
  deepseek: 1.0,
  sonnet:   11.0,
  opus:     19.0,
};
const NEW_LLM_MULTIPLIERS: Record<string, number> = {
  deepseek: 1.0,
  sonnet:   13.0,
  opus:     21.0,
};
// Service-role client used ONLY for the user_plans lookup (RLS bypasses).
const _planClient = SUPABASE_URL && SUPABASE_SECRET_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY)
  : null;
async function getIsLegacyPlan(userId: string): Promise<boolean> {
  if (!userId || !_planClient) return true;
  try {
    const { data, error } = await _planClient
      .from('user_plans')
      .select('is_legacy_plan')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    if (error || !data) return true;
    return (data as { is_legacy_plan?: boolean }).is_legacy_plan === true;
  } catch (_) {
    return true;
  }
}
function llmMultiplier(isLegacy: boolean, model: string): number {
  const map = isLegacy ? LEGACY_LLM_MULTIPLIERS : NEW_LLM_MULTIPLIERS;
  return map[model] ?? 1.0;
}

// Circuit breaker functions
function checkCircuitBreaker(model: string): boolean {
  const state = CIRCUIT_BREAKER_STATE[model as keyof typeof CIRCUIT_BREAKER_STATE];
  if (!state) return true;
  
  const now = Date.now();
  
  // Reset circuit breaker after timeout
  if (state.isOpen && (now - state.lastFailure) > CIRCUIT_BREAKER_TIMEOUT) {
    console.log(`Circuit breaker reset for ${model}`);
    state.failures = 0;
    state.isOpen = false;
  }
  
  return !state.isOpen;
}

function recordCircuitBreakerFailure(model: string) {
  const state = CIRCUIT_BREAKER_STATE[model as keyof typeof CIRCUIT_BREAKER_STATE];
  if (!state) return;
  
  state.failures++;
  state.lastFailure = Date.now();
  
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    console.log(`Circuit breaker opened for ${model} after ${state.failures} failures`);
    state.isOpen = true;
  }
}

function recordCircuitBreakerSuccess(model: string) {
  const state = CIRCUIT_BREAKER_STATE[model as keyof typeof CIRCUIT_BREAKER_STATE];
  if (!state) return;
  
  state.failures = 0;
  state.isOpen = false;
}

// Create client based on model
function createModelClient(model: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) {
    throw new Error(`Unsupported model: ${model}`);
  }
  
  if (!config.apiKey) {
    throw new Error(`API key not set for model: ${model}`);
  }

  if (model === 'deepseek') {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
  } else {
    // For Claude models, we'll handle this differently in the API call
    return { apiKey: config.apiKey };
  }
}

// Non-streaming fallback for DeepSeek
async function callDeepSeekNonStreaming(client: any, messages: any[], options: any) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${client.apiKey}`
    },
    body: JSON.stringify({
      ...options,
      messages: messages,
      stream: false // Non-streaming
    }),
    signal: AbortSignal.timeout(300000) // 5 minutes
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

// Enhanced API call wrapper with multiple timeout mechanisms
async function callModelWithEnhancedTimeout(client: any, messages: any[], options: any, model: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  
  // Create multiple timeout mechanisms
  const controller = new AbortController();
  const primaryTimeout = setTimeout(() => controller.abort(), config.timeout);
  
  // Watchdog timer - independent backup timeout
  let watchdogTimer: number | null = null;
  let isCompleted = false;
  
  const watchdogPromise = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => {
      if (!isCompleted) {
        console.error(`Watchdog timeout triggered for ${model} after ${config.timeout + 30000}ms`);
        controller.abort();
        reject(new Error(`${model} API call watchdog timeout`));
      }
    }, config.timeout + 30000); // 30 seconds after main timeout
  });

  try {
    if (model === 'deepseek') {
      // Add connection health check before streaming
      const healthCheck = await Promise.race([
        fetch('https://api.deepseek.com/v1/models', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${config.apiKey}` },
          signal: AbortSignal.timeout(10000) // 10 second health check
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Health check timeout')), 10000)
        )
      ]);

      if (!healthCheck.ok) {
        throw new Error(`DeepSeek API health check failed: ${healthCheck.status}`);
      }

      console.log('DeepSeek API health check passed, starting streaming...');

      // Race between actual call and watchdog
      const streamPromise = (async () => {
        const stream = await client.chat.completions.create({
          ...options,
          messages: messages,
          stream: true,
          signal: controller.signal as any
        });
        
        let content = "";
        let lastChunkTime = Date.now();
        
        for await (const chunk of stream) {
          if (chunk.choices[0]?.delta?.content) {
            content += chunk.choices[0].delta.content;
            lastChunkTime = Date.now();
          }
          
          // Check if we haven't received data in too long (stalled stream)
          if (Date.now() - lastChunkTime > 180000) { // 3 minutes without data
            throw new Error('DeepSeek stream stalled - no data received for 3 minutes');
          }
        }
        
        isCompleted = true;
        return {
          choices: [{ message: { content } }],
          usage: {
            prompt_tokens: estimateTokens(messages.map(m => m.content).join('')),
            completion_tokens: estimateTokens(content)
          }
        };
      })();

      const result = await Promise.race([streamPromise, watchdogPromise]);
      return result;
      
    } else {
      // Claude models remain unchanged but add watchdog
      const claudePromise = (async () => {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': client.apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
            max_tokens: options.max_tokens || 64000,
            temperature: options.temperature || 0.7,
            system: messages[0].content,
            messages: [{ role: 'user', content: messages[1].content }]
          }),
          signal: controller.signal as any
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        
        const result = await response.json();
        isCompleted = true;
        
        return {
          choices: [{ message: { content: result.content[0].text } }],
          usage: {
            prompt_tokens: result.usage?.input_tokens || 0,
            completion_tokens: result.usage?.output_tokens || 0
          }
        };
      })();

      const result = await Promise.race([claudePromise, watchdogPromise]);
      return result;
    }
  } catch (error) {
    isCompleted = true;
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
      throw new Error(`${model} API call timed out or was aborted`);
    }
    throw error;
  } finally {
    clearTimeout(primaryTimeout);
    if (watchdogTimer) clearTimeout(watchdogTimer);
  }
}

// Updated callModelWithTimeout with fallback mechanisms
async function callModelWithTimeout(client: any, messages: any[], options: any, model: string) {
  if (model === 'deepseek') {
    // Check if we should use non-streaming fallback
    const useNonStreaming = CIRCUIT_BREAKER_STATE.deepseek?.failures > 1;
    
    if (useNonStreaming) {
      console.log('Using non-streaming DeepSeek API due to previous failures');
      const result = await callDeepSeekNonStreaming(client, messages, options);
      return {
        choices: result.choices,
        usage: result.usage || {
          prompt_tokens: estimateTokens(messages.map(m => m.content).join('')),
          completion_tokens: estimateTokens(result.choices[0].message.content)
        }
      };
    }
    
    // Try streaming first, fall back to non-streaming on failure
    try {
      return await callModelWithEnhancedTimeout(client, messages, options, model);
    } catch (error) {
      console.warn('Streaming failed, trying non-streaming fallback:', error.message);
      const result = await callDeepSeekNonStreaming(client, messages, options);
      return {
        choices: result.choices,
        usage: result.usage || {
          prompt_tokens: estimateTokens(messages.map(m => m.content).join('')),
          completion_tokens: estimateTokens(result.choices[0].message.content)
        }
      };
    }
  } else {
    // Claude models use enhanced timeout
    return await callModelWithEnhancedTimeout(client, messages, options, model);
  }
}

// Enhanced retry function with circuit breaker
async function retryOutlineAsync(
  title: string,
  description: string,
  wordCount: number,
  groupId: string,
  userId: string,
  videoProcess: boolean,
  language: string,
  model: string,
  attempt: number = 1,
  lastError: string = '',
  pauses: boolean = false,
  tab: number = 1
) {
  if (attempt > 3) {
    console.error(`Max async retry attempts reached for group ${groupId}. Last error: ${lastError}`);
    
    // Try fallback model if available
    const fallbackModel = model === 'deepseek' ? 'sonnet' : (model === 'sonnet' ? 'deepseek' : null);
    if (fallbackModel && checkCircuitBreaker(fallbackModel)) {
      console.log(`Attempting fallback to ${fallbackModel} for group ${groupId}`);
      retryOutlineAsync(title, description, wordCount, groupId, userId, videoProcess, language, fallbackModel, 1, `Fallback from ${model}`, pauses, tab);
    }
    return;
  }

  // Check circuit breaker
  if (!checkCircuitBreaker(model)) {
    console.log(`Circuit breaker open for ${model}, trying fallback for group ${groupId}`);
    const fallbackModel = model === 'deepseek' ? 'sonnet' : (model === 'sonnet' ? 'deepseek' : null);
    if (fallbackModel) {
      retryOutlineAsync(title, description, wordCount, groupId, userId, videoProcess, language, fallbackModel, 1, `Circuit breaker open for ${model}`, pauses, tab);
    }
    return;
  }

  const retryDelay = Math.min(30000 * Math.pow(2, attempt - 1), 300000); // Exponential backoff, max 5 minutes
  const jitter = Math.random() * 10000; // Add jitter

  setTimeout(async () => {
    try {
      console.log(`Enhanced async retry attempt ${attempt} for group ${groupId} using ${model}`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        console.log(`Aborting retry attempt ${attempt} due to timeout`);
        controller.abort();
      }, 480000); // 8 minutes for retry attempts

      const response = await fetch('https://storyscriptai-outline.storyscriptai.deno.net/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SECRET_KEY,
        },
        body: JSON.stringify({
          title,
          description,
          wordCount,
          groupId,
          userId,
          videoProcess,
          language,
          model,
          tab,
          pauses,
          _retryAttempt: attempt + 1
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      console.log(`Enhanced async retry ${attempt} succeeded for group ${groupId}`);
      recordCircuitBreakerSuccess(model);
      
    } catch (error: any) {
      console.error(`Enhanced async retry ${attempt} error:`, error.message);
      recordCircuitBreakerFailure(model);
      
      // Retry with next attempt
      retryOutlineAsync(
        title, 
        description, 
        wordCount, 
        groupId, 
        userId, 
        videoProcess, 
        language, 
        model, 
        attempt + 1,
        error.message,
        pauses,
        tab
      );
    }
  }, retryDelay + jitter);
}

async function detectContentType(
  title: string,
  description: string,
  masterPrompt: any,
  youtubeTranscript: string | null
): Promise<string> {
  const VALID_TYPES = ['story', 'documentary', 'informational', 'commentary'];
  
  try {
    const apiKey = MODEL_CONFIGS.sonnet.apiKey;
    if (!apiKey) {
      console.warn('No Anthropic API key for content_type detection, defaulting to story');
      return 'story';
    }

    let contextParts = [`Title: ${title}`, `Description: ${description}`];
    if (masterPrompt) {
      const mp = typeof masterPrompt === 'string' ? masterPrompt : JSON.stringify(masterPrompt);
      contextParts.push(`Additional context: ${mp.slice(0, 500)}`);
    }
    if (youtubeTranscript) {
      contextParts.push(`Source transcript excerpt: ${youtubeTranscript.slice(0, 500)}`);
    }

    const classificationPrompt = `Classify the following content request into exactly ONE category:
- story: Creative fiction, narratives, tales, character-driven fictional plots, what-if scenarios
- documentary: Factual accounts of real events, real people, history, true crime, biographies, science, nature
- informational: Educational content, explainers, how-to guides, tutorials, concept breakdowns, analysis of systems or processes
- commentary: Opinion pieces, reviews, argumentative essays, cultural/political analysis, commentary on current events

${contextParts.join('\n')}

Respond with ONLY the category name (one word). No explanation.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        temperature: 0,
        messages: [{ role: 'user', content: classificationPrompt }]
      }),
    });

    if (!response.ok) {
      console.warn(`Content type detection failed (HTTP ${response.status}), defaulting to story`);
      return 'story';
    }

    const result = await response.json();
    const detected = (result.content?.[0]?.text || '').trim().toLowerCase();
    
    if (VALID_TYPES.includes(detected)) {
      console.log(`Detected content_type: ${detected}`);
      return detected;
    }
    
    console.log(`Content type detection returned '${detected}', defaulting to story`);
    return 'story';
  } catch (error: any) {
    console.warn(`Content type detection error: ${error.message}, defaulting to story`);
    return 'story';
  }
}

function buildContentTypeOutlineInstructions(contentType: string): string {
  if (contentType === 'story') return '';
  
  const instructions: Record<string, string> = {
    documentary: `

CONTENT TYPE: DOCUMENTARY
This is a DOCUMENTARY script, NOT fiction. Adjust your outline accordingly:
- Plan sections that follow a logical chronological or thematic progression about real events, people, or phenomena
- Each chapter should cover factual events, documented evidence, or real-world analysis
- Summaries should reference specific facts, dates, locations, and real people/organizations
- Build a compelling factual narrative through evidence and historical progression
- The final content will be read by a SINGLE third-person narrator for text-to-speech — plan accordingly
- Do NOT plan dialogue, character conversations, or screenplay-style content
- All information should be conveyed through authoritative narration
- When people are quoted, plan for indirect/reported speech (e.g., "According to X..." not direct quotes)`,

    informational: `

CONTENT TYPE: INFORMATIONAL/EDUCATIONAL
This is an INFORMATIONAL script, NOT fiction. Adjust your outline accordingly:
- Plan sections that systematically explain concepts, processes, or topics
- Each chapter should build understanding progressively — from foundational concepts to deeper insights
- Summaries MUST reference specific data points, statistics, numbers, measurements, named technologies, companies, and expert perspectives from the source material — avoid vague summaries
- Plan for high factual density: every chapter summary should mention at least 2-3 specific facts, figures, or named entities that the writer must include
- Focus on clarity, education, and engaging explanation rather than dramatic narrative
- The final content will be read by a SINGLE third-person narrator for text-to-speech — plan accordingly
- Do NOT plan dialogue, character conversations, or screenplay-style content
- All explanations should be conveyed through the narrator's clear, educational description
- Plan for concrete examples and analogies to illustrate complex ideas`,

    commentary: `

CONTENT TYPE: COMMENTARY/ANALYSIS
This is a COMMENTARY/ANALYSIS script, NOT fiction. Adjust your outline accordingly:
- Plan sections that build a well-reasoned analysis or perspective on the topic
- Each chapter should present viewpoints, evidence, and insights
- Summaries MUST reference specific arguments, data points, statistics, named sources, and concrete examples from the source material — avoid vague summaries
- Plan for high factual density: every chapter summary should mention at least 2-3 specific facts, figures, or named entities that the writer must weave into the analysis
- Focus on thoughtful analysis, balanced consideration, and compelling argumentation
- The final content will be read by a SINGLE third-person narrator for text-to-speech — plan accordingly
- Do NOT plan dialogue, character conversations, or screenplay-style content
- All analysis must be conveyed through the narrator's authoritative voice
- When referencing others' opinions, plan for indirect/reported speech`,
  };
  
  return instructions[contentType] || '';
}

function getSystemPrompts(language: string, isShortStory: boolean, sanitizedWordCount: number, minBatches: number, minChapters: number, model: string, contentType: string = 'story') {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  const maxWordsPerBatch = config.maxWordsPerBatch;
  
  // Different prompts based on model type - check Claude models first before short/long classification
  if (model === 'sonnet' || model === 'opus') {
    // Claude models use 3000-word batches (updated from 3500)
    if (sanitizedWordCount <= maxWordsPerBatch) {
      // Single batch for stories that fit in one batch
      const prompts = {
        english: `You are an expert story planner. Create a detailed outline for a story with the given title, description, and total word count of ${sanitizedWordCount} words. Since this fits within a single batch, create ONE comprehensive chapter that tells the complete story. Follow these steps:
1. Create a single chapter with a descriptive title and target word count of ${sanitizedWordCount} words.
2. CRITICAL PACING RULE: Plan ONLY as many segments or events as can realistically be written in ${sanitizedWordCount} words with proper depth and prose quality. On average, one well-written narrative segment takes 300-500 words. For ${sanitizedWordCount} words, plan a maximum of ${Math.max(2, Math.floor(sanitizedWordCount / 400))} segments. The final segment MUST be the story's closing/conclusion — never plan more content than what can finish within the word limit.
3. Provide a detailed summary including specific plot points, character moments, and thematic elements that covers a complete story arc from beginning to end — with a proper conclusion built into the plan.
4. Assign this single chapter to one batch.
5. Format the outline strictly as follows:

1. Chapter Title - ${sanitizedWordCount} words: Complete story summary with beginning, middle, and end

Batch Plan:
- Batch 1: Chapters [1], Total Words: ${sanitizedWordCount}

Example:
1. The Discovery and Transformation - 3000 words: Marcus Chen, a corporate accountant, discovers his love for dancing at a company event, experiences initial resistance and self-doubt, secretly pursues lessons, faces the choice between his old life and new passion, and ultimately embraces dancing as his authentic self, leading to personal transformation and a new life direction.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 3000

Do not include placeholders or additional commentary.`,

        german: `Sie sind ein Experte für Geschichtenplanung. Erstellen Sie eine detaillierte Gliederung für eine Geschichte mit dem gegebenen Titel, der Beschreibung und der Gesamtwortzahl von ${sanitizedWordCount} Wörtern. Da dies in einen einzigen Batch passt, erstellen Sie EIN umfassendes Kapitel, das die vollständige Geschichte erzählt. Befolgen Sie diese Schritte:
1. Erstellen Sie ein einzelnes Kapitel mit einem beschreibenden Titel und einer Zielwortzahl von ${sanitizedWordCount} Wörtern.
2. KRITISCHE TEMPOREGEL: Planen Sie NUR so viele Segmente oder Ereignisse, wie bei ${sanitizedWordCount} Wörtern mit ausreichender Tiefe realistisch geschrieben werden können. Ein gut geschriebenes Segment benötigt durchschnittlich 300-500 Wörter. Für ${sanitizedWordCount} Wörter planen Sie maximal ${Math.max(2, Math.floor(sanitizedWordCount / 400))} Segmente. Das letzte Segment MUSS der Abschluss der Geschichte sein.
3. Geben Sie eine detaillierte Zusammenfassung an, die spezifische Handlungspunkte, Charaktermomente und thematische Elemente enthält, die einen vollständigen Geschichtenbogen von Anfang bis Ende mit einem echten Abschluss abdeckt.
4. Weisen Sie dieses einzelne Kapitel einem Batch zu.
5. Formatieren Sie die Gliederung strikt wie folgt:

1. Kapiteltitel - ${sanitizedWordCount} Wörter: Vollständige Geschichtszusammenfassung mit Anfang, Mitte und Ende

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: ${sanitizedWordCount}

Beispiel:
1. Die Entdeckung und Transformation - 3000 Wörter: Marcus Chen, ein Firmenangestellter, entdeckt seine Liebe zum Tanzen bei einer Firmenveranstaltung, erlebt anfänglichen Widerstand und Selbstzweifel, verfolgt heimlich Tanzstunden, steht vor der Wahl zwischen seinem alten Leben und seiner neuen Leidenschaft und nimmt schließlich das Tanzen als sein authentisches Selbst an, was zu persönlicher Transformation und einer neuen Lebensrichtung führt.

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: 3000

Fügen Sie keine Platzhalter oder zusätzliche Kommentare hinzu.`,

        spanish: `Eres un experto planificador de historias. Crea un esquema detallado para una historia con el título, descripción y recuento total de ${sanitizedWordCount} palabras dados. Como esto cabe en un solo lote, crea UN capítulo integral que cuente la historia completa. Sigue estos pasos:
1. Crea un solo capítulo con un título descriptivo y recuento objetivo de ${sanitizedWordCount} palabras.
2. REGLA CRÍTICA DE RITMO: Planifica SOLO tantos segmentos o eventos como puedan escribirse de manera realista con ${sanitizedWordCount} palabras con suficiente profundidad. Un segmento bien escrito requiere en promedio 300-500 palabras. Para ${sanitizedWordCount} palabras, planifica un máximo de ${Math.max(2, Math.floor(sanitizedWordCount / 400))} segmentos. El segmento final DEBE ser el cierre/conclusión de la historia.
3. Proporciona un resumen detallado que incluya puntos específicos de la trama, momentos de personajes y elementos temáticos que cubra un arco completo de principio a fin con una conclusión adecuada.
4. Asigna este único capítulo a un lote.
5. Formatea el esquema estrictamente como sigue:

1. Título del Capítulo - ${sanitizedWordCount} palabras: Resumen completo de la historia con inicio, medio y final

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: ${sanitizedWordCount}

Ejemplo:
1. El Descubrimiento y la Transformación - 3000 palabras: Marcus Chen, un contador corporativo, descubre su amor por el baile en un evento de la empresa, experimenta resistencia inicial y dudas sobre sí mismo, persigue secretamente lecciones, enfrenta la elección entre su vida anterior y su nueva pasión, y finalmente abraza el baile como su yo auténtico, llevando a la transformación personal y una nueva dirección de vida.

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: 3000

No incluyas marcadores de posición o comentarios adicionales.`,

        french: `Vous êtes un expert en planification d'histoires. Créez un plan détaillé pour une histoire avec le titre, la description et le nombre total de ${sanitizedWordCount} mots donnés. Comme cela tient dans un seul lot, créez UN chapitre complet qui raconte l'histoire complète. Suivez ces étapes :
1. Créez un seul chapitre avec un titre descriptif et un nombre cible de ${sanitizedWordCount} mots.
2. RÈGLE CRITIQUE DE RYTHME : Planifiez UNIQUEMENT autant de segments ou d'événements que ce qui peut être écrit de manière réaliste avec ${sanitizedWordCount} mots avec une profondeur suffisante. Un segment bien écrit nécessite en moyenne 300-500 mots. Pour ${sanitizedWordCount} mots, planifiez un maximum de ${Math.max(2, Math.floor(sanitizedWordCount / 400))} segments. Le dernier segment DOIT être la conclusion de l'histoire.
3. Fournissez un résumé détaillé incluant des points spécifiques de l'intrigue, des moments de personnages et des éléments thématiques qui couvre un arc complet du début à la fin avec une vraie conclusion.
4. Assignez ce chapitre unique à un lot.
5. Formatez le plan strictement comme suit :

1. Titre du Chapitre - ${sanitizedWordCount} mots : Résumé complet de l'histoire avec début, milieu et fin

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : ${sanitizedWordCount}

Exemple :
1. La Découverte et la Transformation - 3000 mots : Marcus Chen, un comptable d'entreprise, découvre son amour pour la danse lors d'un événement d'entreprise, vit une résistance initiale et des doutes sur lui-même, poursuit secrètement des cours, fait face au choix entre son ancienne vie et sa nouvelle passion, et embrasse finalement la danse comme son moi authentique, menant à une transformation personnelle et une nouvelle direction de vie.

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : 3000

N'incluez pas de marqueurs de position ou de commentaires supplémentaires.`
      };
      return (prompts[language as keyof typeof prompts] || prompts.english) + buildContentTypeOutlineInstructions(contentType);
    } else if (sanitizedWordCount < 8000) {
      // Multi-chapter for medium stories
      const prompts = {
        english: `You are an expert story planner. Create a detailed outline for a story with the given title, description, and total word count. Follow these steps:
1. Divide the story into chapters, each with a unique, descriptive title, a target word count (up to ${maxWordsPerBatch} words per chapter), and a detailed summary including specific plot points, character moments, and thematic elements.
2. MATHEMATICAL REQUIREMENT: All chapter word counts must sum to EXACTLY ${sanitizedWordCount} words. Current total must equal ${sanitizedWordCount}. Double-check your arithmetic.
3. Each chapter can be up to ${maxWordsPerBatch} words. Only split chapters into parts if absolutely necessary for story structure.
4. Assign each chapter to its own batch. Each batch should contain one chapter and not exceed ${maxWordsPerBatch} words.
5. Before finalizing, verify: Sum all chapter word counts = ${sanitizedWordCount}. If not exactly ${sanitizedWordCount}, adjust chapter word counts to reach exactly ${sanitizedWordCount}.
6. Format the outline strictly as follows:

1. Chapter Title - WordCount words: Summary
2. Chapter Title - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2], Total Words: WordCount
(etc.)

Example:
1. The Discovery - 1500 words: Marcus Chen discovers his love for dancing at a company event, experiencing joy and freedom for the first time.
2. The Resistance and Transformation - 1500 words: Marcus faces opposition but pursues dancing, leading to major life changes and personal growth.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 1500
- Batch 2: Chapters [2], Total Words: 1500

CRITICAL: Total chapters must sum to EXACTLY ${sanitizedWordCount} words. Double-check your arithmetic. Each batch must reference chapters correctly using format [1], [2], etc. Ensure each batch ≤ ${maxWordsPerBatch} words and the total equals EXACTLY ${sanitizedWordCount}. Do not include placeholders or additional commentary.`,

        german: `Sie sind ein Experte für Geschichtenplanung. Erstellen Sie eine detaillierte Gliederung für eine Geschichte mit dem gegebenen Titel, der Beschreibung und der Gesamtwortzahl. Befolgen Sie diese Schritte:
1. Teilen Sie die Geschichte in Kapitel auf, jedes mit einem eindeutigen Titel, einer Zielwortzahl (bis zu ${maxWordsPerBatch} Wörter pro Kapitel) und einer detaillierten Zusammenfassung.
2. MATHEMATISCHE ANFORDERUNG: Alle Kapitel-Wortzahlen müssen sich zu GENAU ${sanitizedWordCount} Wörtern summieren. Aktuelle Summe muss ${sanitizedWordCount} entsprechen. Überprüfen Sie Ihre Arithmetik.
3. Jedes Kapitel kann bis zu ${maxWordsPerBatch} Wörter haben. Teilen Sie Kapitel nur bei Bedarf in Teile auf.
4. Formatieren Sie die Gliederung strikt wie folgt:

1. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
2. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
(etc.)

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: Wortzahl
- Batch 2: Kapitel [2], Gesamtwörter: Wortzahl
(etc.)

KRITISCH: Gesamtkapitel müssen sich zu GENAU ${sanitizedWordCount} Wörtern summieren. Überprüfen Sie Ihre Arithmetik doppelt.`,

        spanish: `Eres un experto planificador de historias. Crea un esquema detallado para una historia con el título, descripción y recuento total de palabras dados. Sigue estos pasos:
1. Divide la historia en capítulos, cada uno con un título único, recuento objetivo (hasta ${maxWordsPerBatch} palabras por capítulo) y resumen detallado.
2. REQUISITO MATEMÁTICO: Todos los recuentos de palabras de capítulos deben sumar EXACTAMENTE ${sanitizedWordCount} palabras. El total actual debe igualar ${sanitizedWordCount}. Verifica tu aritmética.
3. Cada capítulo puede tener hasta ${maxWordsPerBatch} palabras. Solo divide capítulos en partes si es absolutamente necesario.
4. Formatea el esquema estrictamente como sigue:

1. Título del Capítulo - Recuento palabras: Resumen
2. Título del Capítulo - Recuento palabras: Resumen
(etc.)

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: Recuento
- Lote 2: Capítulos [2], Total de Palabras: Recuento
(etc.)

CRÍTICO: Los capítulos totales deben sumar EXACTAMENTE ${sanitizedWordCount} palabras. Verifica tu aritmética dos veces.`,

        french: `Vous êtes un expert en planification d'histoires. Créez un plan détaillé pour une histoire avec le titre, la description et le nombre total de mots donnés. Suivez ces étapes :
1. Divisez l'histoire en chapitres, chacun avec un titre unique, nombre cible (jusqu'à ${maxWordsPerBatch} mots par chapitre) et résumé détaillé.
2. EXIGENCE MATHÉMATIQUE : Tous les nombres de mots des chapitres doivent totaliser EXACTEMENT ${sanitizedWordCount} mots. Le total actuel doit égaler ${sanitizedWordCount}. Vérifiez votre arithmétique.
3. Chaque chapitre peut avoir jusqu'à ${maxWordsPerBatch} mots. Ne divisez les chapitres en parties que si absolument nécessaire.
4. Formatez le plan strictement comme suit :

1. Titre du Chapitre - Nombre mots : Résumé
2. Titre du Chapitre - Nombre mots : Résumé
(etc.)

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : Nombre
- Lot 2 : Chapitres [2], Total de Mots : Nombre
(etc.)

CRITIQUE : Les chapitres totaux doivent totaliser EXACTEMENT ${sanitizedWordCount} mots. Vérifiez votre arithmétique deux fois.`
      };
      return (prompts[language as keyof typeof prompts] || prompts.english) + buildContentTypeOutlineInstructions(contentType);
    } else {
      // Large novels
      const prompts = {
        english: `You are an expert story planner. Create a detailed outline for a novel with the given title, description, and total word count. Follow these steps exactly:
1. Plan a cohesive story arc covering EXACTLY ${sanitizedWordCount} words, with a clear beginning, middle, and end. Divide the story into chapters, each with a unique, descriptive title and detailed summary.
2. Each chapter can be up to ${maxWordsPerBatch} words. Use the full capacity - aim for chapters between 2000-${maxWordsPerBatch} words to minimize the number of batches while maintaining story quality.
3. Create AT LEAST ${minBatches} chapters to reach the target word count. Each chapter should be substantial and well-developed.
4. MATHEMATICAL REQUIREMENT: All chapter word counts must sum to EXACTLY ${sanitizedWordCount} words. CRITICAL: Verify your arithmetic. Add up all chapter word counts: chapter1 + chapter2 + chapter3 + ... = ${sanitizedWordCount}. If the sum is not exactly ${sanitizedWordCount}, adjust chapter word counts until the total equals exactly ${sanitizedWordCount}.
5. Before finalizing, verify: Sum all chapter word counts = ${sanitizedWordCount}. If not exactly ${sanitizedWordCount}, adjust chapter word counts to reach exactly ${sanitizedWordCount}.
6. Assign each chapter to its own batch. Each batch contains exactly one chapter and must not exceed ${maxWordsPerBatch} words.
7. Format the outline exactly as follows:

1. Chapter Title - WordCount words: Summary
2. Chapter Title - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2], Total Words: WordCount
(etc.)

Example:
1. The Discovery - 3000 words: Marcus Chen, a corporate accountant, accidentally discovers salsa dancing at a work event. His initial reluctance transforms into fascination as he experiences movement, music, and joy for the first time, setting him on a path that will challenge everything he knows about himself.
2. The Resistance - 3000 words: Marcus faces internal and external opposition as he secretly pursues dancing. His girlfriend and colleagues dismiss his new passion, leading to conflicts that force him to examine his priorities and the life he's built.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 3000
- Batch 2: Chapters [2], Total Words: 3000

CRITICAL: Total chapters must sum to EXACTLY ${sanitizedWordCount} words. Double-check your arithmetic before finalizing. Each batch must reference chapters correctly using format [1], [2], etc. Ensure the total word count meets EXACTLY ${sanitizedWordCount} words. Each chapter should be substantial and detailed. Do not include placeholders.`,

        german: `Sie sind ein Experte für Geschichtenplanung. Erstellen Sie eine detaillierte Gliederung für einen Roman mit dem gegebenen Titel, der Beschreibung und der Gesamtwortzahl. Befolgen Sie diese Schritte genau:
1. Planen Sie einen zusammenhängenden Geschichtenbogen, der GENAU ${sanitizedWordCount} Wörter umfasst. Teilen Sie die Geschichte in Kapitel auf, jedes mit einem eindeutigen Titel und detaillierter Zusammenfassung.
2. Jedes Kapitel kann bis zu ${maxWordsPerBatch} Wörter haben. Nutzen Sie die volle Kapazität - zielen Sie auf Kapitel zwischen 2000-${maxWordsPerBatch} Wörter ab.
3. Erstellen Sie MINDESTENS ${minBatches} Kapitel, um die Zielwortzahl zu erreichen.
4. MATHEMATISCHE ANFORDERUNG: Alle Kapitel-Wortzahlen müssen sich zu GENAU ${sanitizedWordCount} Wörtern summieren. KRITISCH: Überprüfen Sie Ihre Arithmetik. Addieren Sie alle Kapitel-Wortzahlen: Kapitel1 + Kapitel2 + Kapitel3 + ... = ${sanitizedWordCount}. Wenn die Summe nicht genau ${sanitizedWordCount} ist, passen Sie die Kapitel-Wortzahlen an, bis die Gesamtsumme genau ${sanitizedWordCount} entspricht.
5. Formatieren Sie die Gliederung genau wie folgt:

1. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
2. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
(etc.)

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: Wortzahl
- Batch 2: Kapitel [2], Gesamtwörter: Wortzahl
(etc.)

KRITISCH: Gesamtkapitel müssen sich zu GENAU ${sanitizedWordCount} Wörtern summieren. Überprüfen Sie Ihre Arithmetik doppelt, bevor Sie abschließen.`,

        spanish: `Eres un experto planificador de historias. Crea un esquema detallado para una novela con el título, descripción y recuento total de palabras dados. Sigue estos pasos exactamente:
1. Planifica un arco narrativo cohesivo que cubra EXACTAMENTE ${sanitizedWordCount} palabras. Divide la historia en capítulos, cada uno con título único y resumen detallado.
2. Cada capítulo puede tener hasta ${maxWordsPerBatch} palabras. Usa la capacidad completa - apunta a capítulos entre 2000-${maxWordsPerBatch} palabras.
3. Crea AL MENOS ${minBatches} capítulos para alcanzar el recuento objetivo.
4. REQUISITO MATEMÁTICO: Todos los recuentos de palabras de capítulos deben sumar EXACTAMENTE ${sanitizedWordCount} palabras. CRÍTICO: Verifica tu aritmética. Suma todos los recuentos de palabras de capítulos: capítulo1 + capítulo2 + capítulo3 + ... = ${sanitizedWordCount}. Si la suma no es exactamente ${sanitizedWordCount}, ajusta los recuentos de palabras de capítulos hasta que el total sea exactamente ${sanitizedWordCount}.
5. Formatea el esquema exactamente como sigue:

1. Título del Capítulo - Recuento palabras: Resumen
2. Título del Capítulo - Recuento palabras: Resumen
(etc.)

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: Recuento
- Lote 2: Capítulos [2], Total de Palabras: Recuento
(etc.)

CRÍTICO: Los capítulos totales deben sumar EXACTAMENTE ${sanitizedWordCount} palabras. Verifica tu aritmética dos veces antes de finalizar.`,

        french: `Vous êtes un expert en planification d'histoires. Créez un plan détaillé pour un roman avec le titre, la description et le nombre total de mots donnés. Suivez ces étapes exactement :
1. Planifiez un arc narratif cohésif couvrant EXACTEMENT ${sanitizedWordCount} mots. Divisez l'histoire en chapitres, chacun avec un titre unique et résumé détaillé.
2. Chaque chapitre peut avoir jusqu'à ${maxWordsPerBatch} mots. Utilisez la capacité complète - visez des chapitres entre 2000-${maxWordsPerBatch} mots.
3. Créez AU MOINS ${minBatches} chapitres pour atteindre le nombre cible.
4. EXIGENCE MATHÉMATIQUE : Tous les nombres de mots des chapitres doivent totaliser EXACTEMENT ${sanitizedWordCount} mots. CRITIQUE : Vérifiez votre arithmétique. Additionnez tous les nombres de mots des chapitres : chapitre1 + chapitre2 + chapitre3 + ... = ${sanitizedWordCount}. Si la somme n'est pas exactement ${sanitizedWordCount}, ajustez les nombres de mots des chapitres jusqu'à ce que le total soit exactement ${sanitizedWordCount}.
5. Formatez le plan exactement comme suit :

1. Titre du Chapitre - Nombre mots : Résumé
2. Titre du Chapitre - Nombre mots : Résumé
(etc.)

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : Nombre
- Lot 2 : Chapitres [2], Total de Mots : Nombre
(etc.)

CRITIQUE : Les chapitres totaux doivent totaliser EXACTEMENT ${sanitizedWordCount} mots. Vérifiez votre arithmétique deux fois avant de finaliser.`
      };
      return (prompts[language as keyof typeof prompts] || prompts.english) + buildContentTypeOutlineInstructions(contentType);
    }
  }
  
  // DeepSeek prompts (original logic) - these remain unchanged at 1100 words max
  const prompts = {
    english: {
      short: `You are an expert story planner. Create a detailed outline for a short story with the given title, description, and total word count (under 3000 words). Follow these steps:

1. Divide the story into at least ${minChapters} chapters or chapter parts. Each chapter or part must have a unique, descriptive title, a target word count, and a detailed summary including specific plot points, character moments, and thematic elements. Ensure the structure is simple and natural for a shorter story.

2. The total word count for all chapters MUST sum to EXACTLY ${sanitizedWordCount} words. This is critical and non-negotiable.

3. If a chapter's word count exceeds ${maxWordsPerBatch} words, split it into parts (e.g., a 1800-word chapter must be split into two parts, such as 900 words each, with appropriate summaries). Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)').

4. Assign each chapter or chapter part to its own batch, so the number of batches equals the number of chapters or parts. Each batch MUST NOT exceed ${maxWordsPerBatch} words. Ensure the total words across batches equals ${sanitizedWordCount}.

5. In the batch plan, reference chapters or parts using their logical chapter number (e.g., '2 Part 1' and '2 Part 2' for parts of chapter 2), NOT the outline index (e.g., do NOT use '3' for '2 Part 2'). For example, the batch plan should look like:
   - Batch 1: Chapters [1], Total Words: 1100
   - Batch 2: Chapters [2 Part 1], Total Words: 1100
   - Batch 3: Chapters [2 Part 2], Total Words: 1100
   - Batch 4: Chapters [3], Total Words: 1100
   - Batch 5: Chapters [4 Part 1], Total Words: 1100
   - Batch 6: Chapters [4 Part 2], Total Words: 1100
   - Batch 7: Chapters [5], Total Words: 1100
   - Batch 8: Chapters [6], Total Words: 1100

6. Format the outline strictly as follows, with no extra formatting, bolding, Markdown symbols (e.g., ** or *), or additional commentary beyond the chapters and batch plan. Do not include placeholder chapters or summaries (e.g., no titles like "Placeholder Chapter" or summaries like "Placeholder summary"):

1. Chapter Title - WordCount words: Summary
2. Chapter Title (Part 1) - WordCount words: Summary
3. Chapter Title (Part 2) - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2 Part 1], Total Words: WordCount
- Batch 3: Chapters [2 Part 2], Total Words: WordCount
(etc.)

Example:
1. The Encounter - 1100 words: Soldiers spot a mysterious figure in the jungle, their radios failing as tension rises.
2. The Escape (Part 1) - 800 words: The team flees under pressure, navigating dense terrain while hearing unnatural sounds.
3. The Escape (Part 2) - 800 words: They evoke an unseen threat, discovering strange markings on the trees.
4. No One Listens - 1100 words: The survivors reach the extraction point, but their warnings are ignored by command.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 1100
- Batch 2: Chapters [2 Part 1], Total Words: 800
- Batch 3: Chapters [2 Part 2], Total Words: 800
- Batch 4: Chapters [3], Total Words: 1100

Ensure the batch plan assigns each chapter or part to exactly one batch, with each batch ≤ ${maxWordsPerBatch} words, and the total words across batches EXACTLY equals ${sanitizedWordCount}. Each chapter or part must be referenced correctly in the batch plan using its logical chapter number (e.g., "2 Part 1" for chapter 2 part 1, "2 Part 2" for chapter 2 part 2). Do not include notes, alternative plans, placeholders, or any text beyond the required format. Ensure the outline includes EXACTLY enough chapters/parts for at least ${minBatches} batches without truncation.`,
      
      long: `You are an expert story planner. Create a detailed outline for a novel with the given title, description, and total word count. The most critical requirement is to produce AT LEAST ${minBatches} batches, each containing EXACTLY ONE chapter or chapter part with a word count ≤ ${maxWordsPerBatch} words, summing to AT LEAST ${sanitizedWordCount} words. Follow these steps exactly:

1. Plan a cohesive story arc covering AT LEAST ${sanitizedWordCount} words, with a clear beginning, middle, and end. Divide the story into at least ${minBatches} chapter parts, each with a unique, descriptive title and detailed summary including specific plot points, character moments, and thematic elements.

2. Assign each chapter a word count. If a chapter's word count exceeds ${maxWordsPerBatch} words, split it into parts (e.g., a 2200-word chapter into two 1100-word parts). Each part's word count MUST be between 500 and 1100 words. Each part must be listed as a separate chapter with its own index (e.g., '4. Chapter Title (Part 1)', '5. Chapter Title (Part 2)').

3. In the outline, list ONLY the chapters (if ≤ ${maxWordsPerBatch} words) or chapter parts (e.g., "Chapter Title (Part 1)"), not parent chapters. The total word count of all listed chapters/parts MUST sum to AT LEAST ${sanitizedWordCount} words.

4. Assign each chapter or part to its own batch, ensuring AT LEAST ${minBatches} batches. Each batch MUST contain EXACTLY ONE chapter or part, with a word count ≤ ${maxWordsPerBatch} words. The total word count across batches MUST equal the sum of listed chapters/parts.

5. In the batch plan, reference each chapter or part using its logical chapter number (e.g., '2 Part 1' and '2 Part 2' for parts of chapter 2), NOT the outline index (e.g., do NOT use '3' for '2 Part 2'). For example, the batch plan should look like:
   - Batch 1: Chapters [1], Total Words: 1100
   - Batch 2: Chapters [2 Part 1], Total Words: 1100
   - Batch 3: Chapters [2 Part 2], Total Words: 1100
   - Batch 4: Chapters [3], Total Words: 1100
   - Batch 5: Chapters [4 Part 1], Total Words: 1100
   - Batch 6: Chapters [4 Part 2], Total Words: 1100
   - Batch 7: Chapters [5], Total Words: 1100
   - Batch 8: Chapters [6], Total Words: 1100

6. Format the outline exactly as follows, with no extra formatting, bolding, Markdown symbols, or commentary. List only chapters or chapter parts with their word counts and summaries. Do not include placeholder chapters or summaries (e.g., no titles like "Placeholder Chapter" or summaries like "Placeholder summary"):

1. Chapter Title - WordCount words: Summary
2. Chapter Title (Part 1) - WordCount words: Summary
3. Chapter Title (Part 2) - WordCount words: Summary
(etc.)

Batch Plan:
- Batch 1: Chapters [1], Total Words: WordCount
- Batch 2: Chapters [2 Part 1], Total Words: WordCount
- Batch 3: Chapters [2 Part 2], Total Words: WordCount
(etc.)

Example:
1. The Encounter - 1100 words: Soldiers track a mysterious figure in the jungle, finding eerie symbols carved into trees.
2. The Ambush (Part 1) - 1100 words: The team is ambushed, forcing a desperate retreat under gunfire.
3. The Ambush (Part 2) - 1100 words: They escape into a hidden cave, discovering clues about their pursuers.
4. The Revelation - 1100 words: The survivors uncover the truth behind the symbols, facing a moral dilemma.

Batch Plan:
- Batch 1: Chapters [1], Total Words: 1100
- Batch 2: Chapters [2 Part 1], Total Words: 1100
- Batch 3: Chapters [2 Part 2], Total Words: 1100
- Batch 4: Chapters [3], Total Words: 1100

Ensure the batch plan assigns each chapter or part to EXACTLY ONE batch, with ${minBatches} batches, each ≤ ${maxWordsPerBatch} words, and the total words across batches matches the sum of listed chapters/parts. Each chapter or part must be referenced correctly using its logical chapter number (e.g., "2 Part 1" for chapter 2 part 1, "2 Part 2" for chapter 2 part 2). Verify that all batch plan references align with the logical chapter numbers before finalizing the output. Plan the full novel upfront, generating enough chapters/parts to meet the batch and word count requirements without truncation. Do not include notes, alternative plans, placeholders, or text beyond the required format. Ensure the outline includes EXACTLY enough chapters/parts for at least ${minBatches} batches without truncation.`
    },
    
    german: {
      short: `Sie sind ein Experte für Geschichtenplanung. Erstellen Sie eine detaillierte Gliederung für eine Kurzgeschichte mit dem gegebenen Titel, der Beschreibung und der Gesamtwortzahl (unter 3000 Wörtern). Befolgen Sie diese Schritte:

1. Teilen Sie die Geschichte in mindestens ${minChapters} Kapitel oder Kapitelteile auf. Jedes Kapitel oder Teil muss einen eindeutigen, beschreibenden Titel, eine Zielwortzahl und eine detaillierte Zusammenfassung mit spezifischen Handlungspunkten, Charaktermomenten und thematischen Elementen haben. Stellen Sie sicher, dass die Struktur einfach und natürlich für eine kürzere Geschichte ist.

2. Die Gesamtwortzahl aller Kapitel MUSS genau ${sanitizedWordCount} Wörter betragen. Dies ist kritisch und nicht verhandelbar.

3. Wenn die Wortzahl eines Kapitels ${maxWordsPerBatch} Wörter überschreitet, teilen Sie es in Teile auf (z.B. ein 1800-Wort-Kapitel muss in zwei Teile geteilt werden, wie 900 Wörter jeweils, mit entsprechenden Zusammenfassungen). Jeder Teil muss als separates Kapitel mit eigenem Index aufgelistet werden (z.B. '4. Kapiteltitel (Teil 1)', '5. Kapiteltitel (Teil 2)').

4. Weisen Sie jedes Kapitel oder Kapitelteil seinem eigenen Batch zu, sodass die Anzahl der Batches der Anzahl der Kapitel oder Teile entspricht. Jeder Batch darf NICHT ${maxWordsPerBatch} Wörter überschreiten. Stellen Sie sicher, dass die Gesamtwörter über Batches ${sanitizedWordCount} entspricht.

5. Im Batch-Plan verweisen Sie auf Kapitel oder Teile mit ihrer logischen Kapitelnummer (z.B. '2 Teil 1' und '2 Teil 2' für Teile von Kapitel 2), NICHT mit dem Gliederungsindex (z.B. verwenden Sie NICHT '3' für '2 Teil 2'). Zum Beispiel sollte der Batch-Plan so aussehen:
   - Batch 1: Kapitel [1], Gesamtwörter: 1100
   - Batch 2: Kapitel [2 Teil 1], Gesamtwörter: 1100
   - Batch 3: Kapitel [2 Teil 2], Gesamtwörter: 1100
   - Batch 4: Kapitel [3], Gesamtwörter: 1100

6. Formatieren Sie die Gliederung strikt wie folgt, ohne zusätzliche Formatierung, Fettdruck, Markdown-Symbole oder zusätzliche Kommentare jenseits der Kapitel und des Batch-Plans:

1. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
2. Kapiteltitel (Teil 1) - Wortzahl Wörter: Zusammenfassung
3. Kapiteltitel (Teil 2) - Wortzahl Wörter: Zusammenfassung
(etc.)

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: Wortzahl
- Batch 2: Kapitel [2 Teil 1], Gesamtwörter: Wortzahl
- Batch 3: Kapitel [2 Teil 2], Gesamtwörter: Wortzahl
(etc.)

Stellen Sie sicher, dass der Batch-Plan jedes Kapitel oder Teil genau einem Batch zuweist, mit jedem Batch ≤ ${maxWordsPerBatch} Wörtern, und die Gesamtwörter über Batches GENAU ${sanitizedWordCount} entsprechen. Stellen Sie sicher, dass die Gliederung GENAU genug Kapitel/Teile für mindestens ${minBatches} Batches ohne Kürzung enthält.`,
      
      long: `Sie sind ein Experte für Geschichtenplanung. Erstellen Sie eine detaillierte Gliederung für einen Roman mit dem gegebenen Titel, der Beschreibung und der Gesamtwortzahl. Die wichtigste Anforderung ist, MINDESTENS ${minBatches} Batches zu produzieren, die jeweils GENAU EIN Kapitel oder Kapitelteil mit einer Wortzahl ≤ ${maxWordsPerBatch} Wörtern enthalten, die sich zu MINDESTENS ${sanitizedWordCount} Wörtern summieren. Befolgen Sie diese Schritte genau:

1. Planen Sie einen zusammenhängenden Geschichtenbogen, der MINDESTENS ${sanitizedWordCount} Wörter umfasst, mit einem klaren Anfang, Mittelteil und Ende. Teilen Sie die Geschichte in mindestens ${minBatches} Kapitelteile auf, jeder mit einem eindeutigen, beschreibenden Titel und detaillierter Zusammenfassung mit spezifischen Handlungspunkten, Charaktermomenten und thematischen Elementen.

2. Weisen Sie jedem Kapitel eine Wortzahl zu. Wenn die Wortzahl eines Kapitels ${maxWordsPerBatch} Wörter überschreitet, teilen Sie es in Teile auf (z.B. ein 2200-Wort-Kapitel in zwei 1100-Wort-Teile). Die Wortzahl jedes Teils MUSS zwischen 500 und 1100 Wörter betragen. Jeder Teil muss als separates Kapitel mit eigenem Index aufgelistet werden (z.B. '4. Kapiteltitel (Teil 1)', '5. Kapiteltitel (Teil 2)').

3. In der Gliederung listen Sie NUR die Kapitel (wenn ≤ ${maxWordsPerBatch} Wörter) oder Kapitelteile (z.B. "Kapiteltitel (Teil 1)") auf, nicht die übergeordneten Kapitel. Die Gesamtwortzahl aller aufgelisteten Kapitel/Teile MUSS sich zu MINDESTENS ${sanitizedWordCount} Wörtern summieren.

4. Weisen Sie jedes Kapitel oder Teil seinem eigenen Batch zu und stellen Sie MINDESTENS ${minBatches} Batches sicher. Jeder Batch MUSS GENAU EIN Kapitel oder Teil enthalten, mit einer Wortzahl ≤ ${maxWordsPerBatch} Wörtern. Die Gesamtwortzahl über Batches MUSS der Summe der aufgelisteten Kapitel/Teile entsprechen.

5. Im Batch-Plan verweisen Sie auf jedes Kapitel oder Teil mit seiner logischen Kapitelnummer (z.B. '2 Teil 1' und '2 Teil 2' für Teile von Kapitel 2), NICHT mit dem Gliederungsindex (z.B. verwenden Sie NICHT '3' für '2 Teil 2').

6. Formatieren Sie die Gliederung genau wie folgt, ohne zusätzliche Formatierung, Fettdruck, Markdown-Symbole oder Kommentare:

1. Kapiteltitel - Wortzahl Wörter: Zusammenfassung
2. Kapiteltitel (Teil 1) - Wortzahl Wörter: Zusammenfassung
3. Kapiteltitel (Teil 2) - Wortzahl Wörter: Zusammenfassung
(etc.)

Batch-Plan:
- Batch 1: Kapitel [1], Gesamtwörter: Wortzahl
- Batch 2: Kapitel [2 Teil 1], Gesamtwörter: Wortzahl
- Batch 3: Kapitel [2 Teil 2], Gesamtwörter: Wortzahl
(etc.)

Stellen Sie sicher, dass der Batch-Plan jedes Kapitel oder Teil GENAU EINEM Batch zuweist, mit ${minBatches} Batches, jeweils ≤ ${maxWordsPerBatch} Wörtern, und die Gesamtwörter über Batches der Summe der aufgelisteten Kapitel/Teile entspricht. Stellen Sie sicher, dass die Gliederung GENAU genug Kapitel/Teile für mindestens ${minBatches} Batches ohne Kürzung enthält.`
    },
    
    spanish: {
      short: `Eres un experto planificador de historias. Crea un esquema detallado para una historia corta con el título, descripción y recuento total de palabras dados (menos de 3000 palabras). Sigue estos pasos:

1. Divide la historia en al menos ${minChapters} capítulos o partes de capítulos. Cada capítulo o parte debe tener un título único y descriptivo, un recuento de palabras objetivo y un resumen detallado que incluya puntos específicos de la trama, momentos de personajes y elementos temáticos. Asegúrate de que la estructura sea simple y natural para una historia más corta.

2. El recuento total de palabras para todos los capítulos DEBE sumar EXACTAMENTE ${sanitizedWordCount} palabras. Esto es crítico e innegociable.

3. Si el recuento de palabras de un capítulo excede ${maxWordsPerBatch} palabras, divídelo en partes (por ejemplo, un capítulo de 1800 palabras debe dividirse en dos partes, como 900 palabras cada una, con resúmenes apropiados). Cada parte debe listarse como un capítulo separado con su propio índice (por ejemplo, '4. Título del Capítulo (Parte 1)', '5. Título del Capítulo (Parte 2)').

4. Asigna cada capítulo o parte de capítulo a su propio lote, para que el número de lotes sea igual al número de capítulos o partes. Cada lote NO DEBE exceder ${maxWordsPerBatch} palabras. Asegúrate de que el total de palabras en todos los lotes sea igual a ${sanitizedWordCount}.

5. En el plan de lotes, haz referencia a los capítulos o partes usando su número de capítulo lógico (por ejemplo, '2 Parte 1' y '2 Parte 2' para partes del capítulo 2), NO el índice del esquema (por ejemplo, NO uses '3' para '2 Parte 2'). Por ejemplo, el plan de lotes debería verse así:
   - Lote 1: Capítulos [1], Total de Palabras: 1100
   - Lote 2: Capítulos [2 Parte 1], Total de Palabras: 1100
   - Lote 3: Capítulos [2 Parte 2], Total de Palabras: 1100
   - Lote 4: Capítulos [3], Total de Palabras: 1100

6. Formatea el esquema estrictamente como sigue, sin formato adicional, negrita, símbolos de Markdown o comentarios adicionales más allá de los capítulos y el plan de lotes:

1. Título del Capítulo - Recuento de Palabras palabras: Resumen
2. Título del Capítulo (Parte 1) - Recuento de Palabras palabras: Resumen
3. Título del Capítulo (Parte 2) - Recuento de Palabras palabras: Resumen
(etc.)

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: Recuento de Palabras
- Lote 2: Capítulos [2 Parte 1], Total de Palabras: Recuento de Palabras
- Lote 3: Capítulos [2 Parte 2], Total de Palabras: Recuento de Palabras
(etc.)

Asegúrate de que el plan de lotes asigne cada capítulo o parte exactamente a un lote, con cada lote ≤ ${maxWordsPerBatch} palabras, y el total de palabras en todos los lotes sea EXACTAMENTE igual a ${sanitizedWordCount}. Asegúrate de que el esquema incluya EXACTAMENTE suficientes capítulos/partes para al menos ${minBatches} lotes sin truncamiento.`,
      
      long: `Eres un experto planificador de historias. Crea un esquema detallado para una novela con el título, descripción y recuento total de palabras dados. El requisito más crítico es producir AL MENOS ${minBatches} lotes, cada uno conteniendo EXACTAMENTE UN capítulo o parte de capítulo con un recuento de palabras ≤ ${maxWordsPerBatch} palabras, sumando AL MENOS ${sanitizedWordCount} palabras. Sigue estos pasos exactamente:

1. Planifica un arco narrativo cohesivo que cubra AL MENOS ${sanitizedWordCount} palabras, con un comienzo, medio y final claros. Divide la historia en al menos ${minBatches} partes de capítulos, cada una con un título único y descriptivo y un resumen detallado que incluya puntos específicos de la trama, momentos de personajes y elementos temáticos.

2. Asigna a cada capítulo un recuento de palabras. Si el recuento de palabras de un capítulo excede ${maxWordsPerBatch} palabras, divídelo en partes (por ejemplo, un capítulo de 2200 palabras en dos partes de 1100 palabras). El recuento de palabras de cada parte DEBE estar entre 500 y 1100 palabras. Cada parte debe listarse como un capítulo separado con su propio índice (por ejemplo, '4. Título del Capítulo (Parte 1)', '5. Título del Capítulo (Parte 2)').

3. En el esquema, lista SOLO los capítulos (si ≤ ${maxWordsPerBatch} palabras) o partes de capítulos (por ejemplo, "Título del Capítulo (Parte 1)"), no los capítulos padre. El recuento total de palabras de todos los capítulos/partes listados DEBE sumar AL MENOS ${sanitizedWordCount} palabras.

4. Asigna cada capítulo o parte a su propio lote, asegurando AL MENOS ${minBatches} lotes. Cada lote DEBE contener EXACTAMENTE UN capítulo o parte, con un recuento de palabras ≤ ${maxWordsPerBatch} palabras. El recuento total de palabras en todos los lotes DEBE ser igual a la suma de los capítulos/partes listados.

5. En el plan de lotes, haz referencia a cada capítulo o parte usando su número de capítulo lógico (por ejemplo, '2 Parte 1' y '2 Parte 2' para partes del capítulo 2), NO el índice del esquema (por ejemplo, NO uses '3' para '2 Parte 2').

6. Formatea el esquema exactamente como sigue, sin formato adicional, negrita, símbolos de Markdown o comentarios:

1. Título del Capítulo - Recuento de Palabras palabras: Resumen
2. Título del Capítulo (Parte 1) - Recuento de Palabras palabras: Resumen
3. Título del Capítulo (Parte 2) - Recuento de Palabras palabras: Resumen
(etc.)

Plan de Lotes:
- Lote 1: Capítulos [1], Total de Palabras: Recuento de Palabras
- Lote 2: Capítulos [2 Parte 1], Total de Palabras: Recuento de Palabras
- Lote 3: Capítulos [2 Parte 2], Total de Palabras: Recuento de Palabras
(etc.)

Asegúrate de que el plan de lotes asigne cada capítulo o parte EXACTAMENTE A UN lote, con ${minBatches} lotes, cada uno ≤ ${maxWordsPerBatch} palabras, y el total de palabras en todos los lotes coincida con la suma de los capítulos/partes listados. Asegúrate de que el esquema incluya EXACTAMENTE suficientes capítulos/partes para al menos ${minBatches} lotes sin truncamiento.`
    },
    
    french: {
      short: `Vous êtes un expert en planification d'histoires. Créez un plan détaillé pour une nouvelle avec le titre, la description et le nombre total de mots donnés (moins de 3000 mots). Suivez ces étapes :

1. Divisez l'histoire en au moins ${minChapters} chapitres ou parties de chapitres. Chaque chapitre ou partie doit avoir un titre unique et descriptif, un nombre de mots cible et un résumé détaillé incluant des points spécifiques de l'intrigue, des moments de personnages et des éléments thématiques. Assurez-vous que la structure soit simple et naturelle pour une histoire plus courte.

2. Le nombre total de mots pour tous les chapitres DOIT totaliser EXACTEMENT ${sanitizedWordCount} mots. C'est critique et non négociable.

3. Si le nombre de mots d'un chapitre dépasse ${maxWordsPerBatch} mots, divisez-le en parties (par exemple, un chapitre de 1800 mots doit être divisé en deux parties, comme 900 mots chacune, avec des résumés appropriés). Chaque partie doit être listée comme un chapitre séparé avec son propre index (par exemple, '4. Titre du Chapitre (Partie 1)', '5. Titre du Chapitre (Partie 2)').

4. Assignez chaque chapitre ou partie de chapitre à son propre lot, de sorte que le nombre de lots soit égal au nombre de chapitres ou parties. Chaque lot NE DOIT PAS dépasser ${maxWordsPerBatch} mots. Assurez-vous que le total des mots sur tous les lots soit égal à ${sanitizedWordCount}.

5. Dans le plan de lots, référencez les chapitres ou parties en utilisant leur numéro de chapitre logique (par exemple, '2 Partie 1' et '2 Partie 2' pour les parties du chapitre 2), PAS l'index du plan (par exemple, N'utilisez PAS '3' pour '2 Partie 2'). Par exemple, le plan de lots devrait ressembler à ceci :
   - Lot 1 : Chapitres [1], Total de Mots : 1100
   - Lot 2 : Chapitres [2 Partie 1], Total de Mots : 1100
   - Lot 3 : Chapitres [2 Partie 2], Total de Mots : 1100
   - Lot 4 : Chapitres [3], Total de Mots : 1100

6. Formatez le plan strictement comme suit, sans formatage supplémentaire, gras, symboles Markdown ou commentaires supplémentaires au-delà des chapitres et du plan de lots :

1. Titre du Chapitre - Nombre de Mots mots : Résumé
2. Titre du Chapitre (Partie 1) - Nombre de Mots mots : Résumé
3. Titre du Chapitre (Partie 2) - Nombre de Mots mots : Résumé
(etc.)

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : Nombre de Mots
- Lot 2 : Chapitres [2 Partie 1], Total de Mots : Nombre de Mots
- Lot 3 : Chapitres [2 Partie 2], Total de Mots : Nombre de Mots
(etc.)

Assurez-vous que le plan de lots assigne chaque chapitre ou partie exactement à un lot, avec chaque lot ≤ ${maxWordsPerBatch} mots, et le total des mots sur tous les lots soit EXACTEMENT égal à ${sanitizedWordCount}. Assurez-vous que le plan inclue EXACTEMENT assez de chapitres/parties pour au moins ${minBatches} lots sans troncature.`,
      
      long: `Vous êtes un expert en planification d'histoires. Créez un plan détaillé pour un roman avec le titre, la description et le nombre total de mots donnés. L'exigence la plus critique est de produire AU MOINS ${minBatches} lots, chacun contenant EXACTEMENT UN chapitre ou partie de chapitre avec un nombre de mots ≤ ${maxWordsPerBatch} mots, totalisant AU MOINS ${sanitizedWordCount} mots. Suivez ces étapes exactement :

1. Planifiez un arc narratif cohésif couvrant AU MOINS ${sanitizedWordCount} mots, avec un début, un milieu et une fin clairs. Divisez l'histoire en au moins ${minBatches} parties de chapitres, chacune avec un titre unique et descriptif et un résumé détaillé incluant des points spécifiques de l'intrigue, des moments de personnages et des éléments thématiques.

2. Assignez à chaque chapitre un nombre de mots. Si le nombre de mots d'un chapitre dépasse ${maxWordsPerBatch} mots, divisez-le en parties (par exemple, un chapitre de 2200 mots en deux parties de 1100 mots). Le nombre de mots de chaque partie DOIT être entre 500 et 1100 mots. Chaque partie doit être listée comme un chapitre séparé avec son propre index (par exemple, '4. Titre du Chapitre (Partie 1)', '5. Titre du Chapitre (Partie 2)').

3. Dans le plan, listez SEULEMENT les chapitres (si ≤ ${maxWordsPerBatch} mots) ou parties de chapitres (par exemple, "Titre du Chapitre (Partie 1)"), pas les chapitres parents. Le nombre total de mots de tous les chapitres/parties listés DOIT totaliser AU MOINS ${sanitizedWordCount} mots.

4. Assignez chaque chapitre ou partie à son propre lot, assurant AU MOINS ${minBatches} lots. Chaque lot DOIT contenir EXACTEMENT UN chapitre ou partie, avec un nombre de mots ≤ ${maxWordsPerBatch} mots. Le nombre total de mots sur tous les lots DOIT être égal à la somme des chapitres/parties listés.

5. Dans le plan de lots, référencez chaque chapitre ou partie en utilisant son numéro de chapitre logique (par exemple, '2 Partie 1' et '2 Partie 2' pour les parties du chapitre 2), PAS l'index du plan (par exemple, N'utilisez PAS '3' pour '2 Partie 2').

6. Formatez le plan exactement comme suit, sans formatage supplémentaire, gras, symboles Markdown ou commentaires :

1. Titre du Chapitre - Nombre de Mots mots : Résumé
2. Titre du Chapitre (Partie 1) - Nombre de Mots mots : Résumé
3. Titre du Chapitre (Partie 2) - Nombre de Mots mots : Résumé
(etc.)

Plan de Lots :
- Lot 1 : Chapitres [1], Total de Mots : Nombre de Mots
- Lot 2 : Chapitres [2 Partie 1], Total de Mots : Nombre de Mots
- Lot 3 : Chapitres [2 Partie 2], Total de Mots : Nombre de Mots
(etc.)

Assurez-vous que le plan de lots assigne chaque chapitre ou partie EXACTEMENT À UN lot, avec ${minBatches} lots, chacun ≤ ${maxWordsPerBatch} mots, et le total des mots sur tous les lots correspond à la somme des chapitres/parties listés. Assurez-vous que le plan inclue EXACTEMENT assez de chapitres/parties pour au moins ${minBatches} lots sans troncature.`
    }
  };

  const langPrompts = prompts[language as keyof typeof prompts] || prompts.english;
  return (isShortStory ? langPrompts.short : langPrompts.long) + buildContentTypeOutlineInstructions(contentType);
}

// Rest of the functions remain the same...
async function triggerParseFunction(
  groupId: string,
  userId: string,
  title: string,
  description: string,
  totalWordCount: number,
  language: string = 'english',
  model: string = 'sonnet',
  tab: number = 1,
  variant: number = 1,
  pauses: boolean = false
): Promise<void> {
  let retries = 0;
  let delay = PARSE_RETRY_DELAY;

  while (retries < PARSE_RETRY_ATTEMPTS) {
    try {
      console.log(`Attempt ${retries + 1} to trigger storyscriptai-parse for group ${groupId}, tab ${tab}`);

      const response = await fetch(PARSE_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SECRET_KEY,
        },
        body: JSON.stringify({
          group_id: groupId,
          user_id: userId,
          title,
          description,
          total_word_count: totalWordCount,
          language,
          model,
          tab,
          variant,
          pauses,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`HTTP ${response.status}: ${errorData.error || 'Unknown error'}`);
      }

      console.log(`Successfully triggered storyscriptai-parse for group ${groupId}, tab ${tab}`);
      return;
    } catch (error: any) {
      retries++;
      if (retries >= PARSE_RETRY_ATTEMPTS) {
        console.error(`Failed to trigger storyscriptai-parse after ${PARSE_RETRY_ATTEMPTS} attempts: ${error.message}`);
        return;
      }
      console.warn(`Retry ${retries}/${PARSE_RETRY_ATTEMPTS} for storyscriptai-parse: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

// Sanitize AI-generated outline that may contain markdown formatting
function sanitizeOutlineOutput(rawText: string, language: string): string {
  const wordPatternStr = Object.values(WORD_PATTERNS).join('|');
  const chapterStartRegex = new RegExp(`^\\d+\\.\\s+.+?-\\s*\\d+\\s*(?:${wordPatternStr})`);
  const hasSummaryRegex = new RegExp(`^\\d+\\.\\s+.+?-\\s*\\d+\\s*(?:${wordPatternStr})\\s*:\\s*.+`);

  // Normalize line endings and split
  let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Normalize Unicode dashes (em —, en –, figure ‒, horizontal bar ―,
  // minus −) to ASCII hyphen. Claude in particular loves emitting em-dashes
  // in the "Title — N words" position, which previously caused
  // chapterStartRegex.test() to fail and dropped every chapter line during
  // sanitization, leaving us with 0 parsed chapters and infinite retries.
  text = text.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-');
  let lines = text.split("\n");

  // Strip markdown formatting from each line
  lines = lines.map(line => {
    let cleaned = line;
    // Remove bold markers
    cleaned = cleaned.replace(/\*\*/g, '');
    // Remove italic markers (standalone * not part of words)
    cleaned = cleaned.replace(/(?<!\w)\*(?!\w)/g, '');
    // Remove heading markers at start of line
    cleaned = cleaned.replace(/^#{1,6}\s+/, '');
    // Remove horizontal rules
    if (/^-{3,}$/.test(cleaned.trim())) return '';
    return cleaned.trim();
  });

  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line) {
      i++;
      continue;
    }

    // Check if this is a chapter line (starts with number. Title - N words)
    if (chapterStartRegex.test(line)) {
      if (hasSummaryRegex.test(line)) {
        // Already has summary inline
        result.push(line);
        i++;
      } else {
        // Chapter line without inline summary — collect following paragraphs as summary
        let summary = '';
        i++;
        while (i < lines.length) {
          const nextLine = lines[i];
          if (!nextLine) {
            i++;
            continue;
          }
          // Stop if we hit another chapter, batch plan, or divider
          if (chapterStartRegex.test(nextLine) ||
              /batch\s*plan/i.test(nextLine) ||
              nextLine.startsWith('- Batch') || nextLine.startsWith('- Lot')) {
            break;
          }
          summary += (summary ? ' ' : '') + nextLine;
          i++;
        }
        if (summary) {
          result.push(`${line}: ${summary}`);
        } else {
          result.push(line);
        }
      }
    } else if (/batch\s*plan/i.test(line)) {
      // Normalize batch plan header to expected format
      result.push('Batch Plan:');
      i++;
    } else if (/^-\s*(Batch|Lot|Lote)\s+\d+/i.test(line)) {
      result.push(line);
      i++;
    } else {
      // Skip other lines (standalone headers, metadata, etc.)
      i++;
    }
  }

  const sanitized = result.join('\n');
  console.log(`DEBUG: Sanitized outline (first 500 chars): ${sanitized.substring(0, 500)}`);
  return sanitized;
}

function parseOutlineChapters(outlineText: string, language: string): Chapter[] {
  // Defensive second pass: even if sanitizeOutlineOutput already normalized
  // dashes, callers may feed us raw outline text. Map all Unicode dash
  // variants to ASCII `-` so the chapter regex below (which uses `-`) matches.
  outlineText = outlineText.replace(/[\u2012\u2013\u2014\u2015\u2212]/g, '-');
  const chapterLines = outlineText.split("Batch Plan:")[0].trim().split("\n").filter(line => line.trim());
  const chapters: Chapter[] = [];
  const titleToLogicalNumber: { [key: string]: number } = {};
  let logicalNum = 1;

  const wordPattern = WORD_PATTERNS[language as keyof typeof WORD_PATTERNS] || WORD_PATTERNS.english;
  
  // Create regex pattern that works for all languages
  const regex = new RegExp(`^(\\d+)\\.\\s+(.+?)(?:\\s*\\(Part\\s*(\\d+)\\))?\\s*-\\s*(\\d+)\\s*${wordPattern}\\s*:\\s*(.+)$`);

  console.log(`DEBUG: Parsing chapters with language: ${language}, word pattern: ${wordPattern}`);

  for (const line of chapterLines) {
    const match = line.match(regex);
    if (match) {
      const index = parseInt(match[1]);
      const chapterTitle = match[2].trim();
      const part = match[3] ? `Part ${match[3]}` : "";
      const wordCountCh = parseInt(match[4]);
      const summary = match[5].trim();

      if (chapterTitle.toLowerCase().includes("placeholder") || summary.toLowerCase().includes("placeholder")) {
        console.log(`Outline contains placeholders in line: ${line}`);
        continue;
      }

      if (!titleToLogicalNumber[chapterTitle]) {
        titleToLogicalNumber[chapterTitle] = logicalNum++;
      }

      const chapter = {
        index,
        logical_number: titleToLogicalNumber[chapterTitle],
        title: chapterTitle,
        part,
        word_count: wordCountCh,
        summary,
        original_line: line,
      };

      chapters.push(chapter);
      
      console.log(`DEBUG: Parsed chapter - Index: ${index}, Logical: ${chapter.logical_number}, Title: "${chapterTitle}", Part: "${part}", Words: ${wordCountCh}`);
    } else {
      console.log(`DEBUG: Failed to parse line: "${line}"`);
    }
  }

  // Create mapping for debugging
  console.log(`DEBUG: Title to Logical Number mapping:`, titleToLogicalNumber);
  
  return chapters;
}

// New function to update outline text with redistributed word counts
function updateOutlineTextWithRedistribution(outlineText: string, chapters: Chapter[], language: string): string {
  const wordPattern = WORD_PATTERNS[language as keyof typeof WORD_PATTERNS] || WORD_PATTERNS.english;
  const [chapterSection, batchSection] = outlineText.split("Batch Plan:");
  
  // Update chapter lines with new word counts
  const updatedChapterLines: string[] = [];
  
  for (const chapter of chapters) {
    const partText = chapter.part ? ` (${chapter.part})` : "";
    const newLine = `${chapter.index}. ${chapter.title}${partText} - ${chapter.word_count} ${wordPattern}: ${chapter.summary}`;
    updatedChapterLines.push(newLine);
  }
  
  const updatedOutlineText = updatedChapterLines.join("\n") + "\n\nBatch Plan:" + batchSection;
  
  console.log("Updated outline text with redistributed word counts");
  return updatedOutlineText;
}

async function generateOutline(
  title: string,
  description: string,
  wordCount: number,
  groupId: string,
  userId: string,
  videoProcess: boolean = false,
  language: string = 'english',
  model: string = 'sonnet',
  tab: number = 1,
  masterPrompt: any = null,
  pauses: boolean = false,
  youtubeTranscript: string | null = null,
  existingOutlineTaskId: string | null = null
): Promise<[string, number, number]> {
  const sanitizedWordCount = Number(wordCount);
  if (isNaN(sanitizedWordCount) || sanitizedWordCount < 200 || sanitizedWordCount > 200000) {
    throw new Error(`Word count must be between 200 and 200,000 (received: ${sanitizedWordCount})`);
  }

  // Validate model
  const supportedModels = ['deepseek', 'sonnet', 'opus'];
  const validatedModel = supportedModels.includes(model) ? model : 'sonnet';
  
  const config = MODEL_CONFIGS[validatedModel as keyof typeof MODEL_CONFIGS];
  const maxWordsPerBatch = config.maxWordsPerBatch;

  const response = await fetch(`${SUPABASE_URL}/rest/v1/story_tasks?group_id=eq.${groupId}&user_id=eq.${userId}&batch_number=eq.0&tab=eq.${tab}&select=id,outline,status,input_tokens,output_tokens`, {
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SECRET_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to check for existing outline: HTTP ${response.status}`);
  }

  const existingTasks = await response.json();

  if (existingTasks && existingTasks.length > 0) {
    const task = existingTasks[0];
    console.log(`Found existing outline task for group ${groupId}, user ${userId}, tab ${tab}, status: ${task.status}`);

    if (task.status === "processing" && task.id !== existingOutlineTaskId) {
      // Check if this is a bare pre-inserted placeholder from master-prompt:
      // no outline, zero tokens — adopt it as our own instead of polling.
      if (!task.outline && (task.input_tokens || 0) === 0 && (task.output_tokens || 0) === 0) {
        console.log(`Adopting pre-inserted task ${task.id} for group ${groupId} (no outline, zero tokens)`);
        existingOutlineTaskId = task.id;
      } else {
        // Another request is truly generating this outline (has non-zero tokens).
        // Poll DB until it completes instead of throwing an error.
        console.log(`Outline already processing for group ${groupId}, polling for completion...`);
        const POLL_INTERVAL = 10000; // 10 seconds
        const MAX_POLLS = 30; // 5 minutes max
        for (let poll = 0; poll < MAX_POLLS; poll++) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
          const pollResponse = await fetch(`${SUPABASE_URL}/rest/v1/story_tasks?id=eq.${task.id}&select=id,outline,status,input_tokens,output_tokens`, {
            headers: {
              "Content-Type": "application/json",
              "apikey": SUPABASE_SECRET_KEY,
            },
          });
          if (!pollResponse.ok) continue;
          const pollTasks = await pollResponse.json();
          if (!pollTasks || pollTasks.length === 0) break;
          const polledTask = pollTasks[0];
          if (polledTask.status === "completed" && polledTask.outline) {
            console.log(`Outline completed during polling for group ${groupId} (poll ${poll + 1})`);
            return [polledTask.outline, polledTask.input_tokens || 0, polledTask.output_tokens || 0];
          }
          if (polledTask.status !== "processing") {
            console.log(`Outline task status changed to ${polledTask.status} during polling, breaking`);
            break;
          }
        }
        // If we get here, the original processing timed out or failed — fall through to generate a new one
        console.log(`Polling exhausted for group ${groupId}, proceeding with fresh outline generation`);
      }
    }

    if (task.outline) {
      console.log(`Reusing existing outline for group ${groupId}, user ${userId}, tab ${tab}`);
      return [task.outline, task.input_tokens || 0, task.output_tokens || 0];
    }
  }

  console.log(`Generating outline for story: ${title}, ${sanitizedWordCount} words, language: ${language}, model: ${validatedModel}, tab: ${tab}, videoProcess: ${videoProcess}`);

  // Check for existing variants in story generation (versions 1, 2)
  const versionsToCheck = [1, 2];
  let finalVariant = 1; // Default variant
  
  // Query story_tasks for existing variants
  const variantCheckResponse = await fetch(`${SUPABASE_URL}/rest/v1/story_tasks?group_id=eq.${groupId}&user_id=eq.${userId}&tab=eq.${tab}&version=in.(${versionsToCheck.join(',')})&select=variant`, {
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SECRET_KEY,
    },
  });
  
  if (variantCheckResponse.ok) {
    const existingTasksVariants = await variantCheckResponse.json();
    
    // Also check story_documents for existing variants
    const docsCheckResponse = await fetch(`${SUPABASE_URL}/rest/v1/story_documents?group_id=eq.${groupId}&user_id=eq.${userId}&tab=eq.${tab}&version=in.(${versionsToCheck.join(',')})&select=variant`, {
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SECRET_KEY,
      },
    });
    
    let existingDocsVariants = [];
    if (docsCheckResponse.ok) {
      existingDocsVariants = await docsCheckResponse.json();
    }
    
    // Collect all existing variants
    const existingVariants = new Set<number>();
    if (existingTasksVariants && existingTasksVariants.length > 0) {
      existingTasksVariants.forEach((t: any) => {
        if (t.variant !== null && t.variant !== undefined) {
          existingVariants.add(t.variant);
        }
      });
    }
    if (existingDocsVariants && existingDocsVariants.length > 0) {
      existingDocsVariants.forEach((d: any) => {
        if (d.variant !== null && d.variant !== undefined) {
          existingVariants.add(d.variant);
        }
      });
    }
    
    // Determine final variant: use requested variant if available, otherwise find next available
    if (existingVariants.has(finalVariant)) {
      // Requested variant exists, find highest and increment
      const highestVariant = Math.max(...Array.from(existingVariants));
      finalVariant = highestVariant + 1;
    }
    
    console.log(`Story outline variant check: requested=${finalVariant}, existing_variants=[${Array.from(existingVariants).sort().join(', ')}], using=${finalVariant}`);
  } else {
    console.warn(`Warning: Could not check existing story variants`);
  }

  const isShortStory = sanitizedWordCount < 3000;
  const minBatches = Math.ceil(sanitizedWordCount / maxWordsPerBatch);
  const minChapters = isShortStory ? MIN_CHAPTERS_SHORT : minBatches;

  // Detect content type — check if already set on pre-inserted row (from master-prompt) to avoid duplicate API call
  let contentType = 'story';
  if (existingOutlineTaskId) {
    try {
      const existingRowResp = await fetch(
        `${SUPABASE_URL}/rest/v1/story_tasks?id=eq.${existingOutlineTaskId}&select=content_type`,
        {
          headers: {
            'apikey': SUPABASE_SECRET_KEY,
          },
        }
      );
      if (existingRowResp.ok) {
        const rows = await existingRowResp.json();
        if (rows?.[0]?.content_type && rows[0].content_type !== 'story') {
          contentType = rows[0].content_type;
          console.log(`Reusing content_type from pre-inserted row: ${contentType}`);
        } else {
          contentType = await detectContentType(title, description, masterPrompt, youtubeTranscript);
        }
      } else {
        contentType = await detectContentType(title, description, masterPrompt, youtubeTranscript);
      }
    } catch (fetchErr: any) {
      console.warn(`Failed to fetch existing row content_type: ${fetchErr.message}`);
      contentType = await detectContentType(title, description, masterPrompt, youtubeTranscript);
    }
  } else {
    contentType = await detectContentType(title, description, masterPrompt, youtubeTranscript);
  }
  console.log(`Content type for outline: ${contentType}`);

  const systemPrompt = getSystemPrompts(language, isShortStory, sanitizedWordCount, minBatches, minChapters, validatedModel, contentType);

  const userPrompts = {
    english: `Create an outline for:\nTitle: ${title}\nDescription: ${description}\nTotal Words: ${sanitizedWordCount}. Make sure you write at least ${minBatches} parts to reach ${sanitizedWordCount} words in total.`,
    german: `Erstellen Sie eine Gliederung für:\nTitel: ${title}\nBeschreibung: ${description}\nGesamtwörter: ${sanitizedWordCount}. Stellen Sie sicher, dass Sie mindestens ${minBatches} Teile schreiben, um insgesamt ${sanitizedWordCount} Wörter zu erreichen.`,
    spanish: `Crea un esquema para:\nTítulo: ${title}\nDescripción: ${description}\nTotal de Palabras: ${sanitizedWordCount}. Asegúrate de escribir al menos ${minBatches} partes para alcanzar ${sanitizedWordCount} palabras en total.`,
    french: `Créez un plan pour :\nTitre : ${title}\nDescription : ${description}\nTotal de Mots : ${sanitizedWordCount}. Assurez-vous d'écrire au moins ${minBatches} parties pour atteindre ${sanitizedWordCount} mots au total.`
  };

  const userPrompt = userPrompts[language as keyof typeof userPrompts] || userPrompts.english;

  let retries = 0;
  let delay = INITIAL_RETRY_DELAY;
  let outlineText = "";
  let inputTokens = 0;
  let outputTokens = 0;

  // Check circuit breaker before starting
  if (!checkCircuitBreaker(validatedModel)) {
    console.log(`Circuit breaker open for ${validatedModel}, using fallback model`);
    const fallbackModel = validatedModel === 'deepseek' ? 'sonnet' : 'deepseek';
    if (checkCircuitBreaker(fallbackModel)) {
      return await generateOutline(title, description, wordCount, groupId, userId, videoProcess, language, fallbackModel, tab, null, pauses);
    } else {
      throw new Error(`All models are circuit broken. Please try again later.`);
    }
  }

  const client = createModelClient(validatedModel);

  // Pre-insert a processing row so the frontend can track outline generation immediately
  // If an existing task ID was passed (e.g. from master-prompt), reuse it instead of creating a new row
  const outlineTaskId = existingOutlineTaskId || crypto.randomUUID();
  const isLegacyPlanForPreInsert = await getIsLegacyPlan(userId);
  const estimatedTokensPreInsert = calculateEstimatedTokens(sanitizedWordCount, validatedModel, false, isLegacyPlanForPreInsert);
  
  if (!existingOutlineTaskId) {
  const processingTask = {
    id: outlineTaskId,
    user_id: userId,
    group_id: groupId,
    batch: [],
    previous_content: null,
    total_word_count: sanitizedWordCount,
    batch_number: 0,
    progress: 0,
    status: "processing",
    story_title: title,
    description: description,
    outline: null,
    total_batches: null,
    is_corrected: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    input_tokens: 0,
    output_tokens: 0,
    variant: finalVariant,
    stop_requested: false,
    video_process: videoProcess,
    language: language,
    model: validatedModel,
    tab: tab,
    estimated_tokens: estimatedTokensPreInsert,
    master_prompt: masterPrompt ? JSON.stringify(masterPrompt) : null,
    pauses: pauses || false,
    youtube_transcript: youtubeTranscript || null,
    content_type: contentType,
  };
  const preInsertResponse = await fetch(`${SUPABASE_URL}/rest/v1/story_tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": SUPABASE_SECRET_KEY,
      "Prefer": "resolution=ignore-duplicates",
    },
    body: JSON.stringify(processingTask),
  });

  if (!preInsertResponse.ok) {
    const preInsertError = await preInsertResponse.text().catch(() => 'Unknown error');
    if (!preInsertError.includes('duplicate') && !preInsertError.includes('unique constraint')) {
      console.warn(`Failed to pre-insert processing task: HTTP ${preInsertResponse.status} - ${preInsertError}`);
    } else {
      console.log(`Processing task already exists for group ${groupId}, tab ${tab} (concurrent request)`);
    }
  } else {
    console.log(`Pre-inserted processing task ${outlineTaskId} for group ${groupId}, tab ${tab}`);
  }
  } else {
    // Update the pre-inserted task with estimated_tokens and other fields
    // that master-prompt may not have set
    console.log(`Reusing existing outline task ${outlineTaskId} from master-prompt pre-insert, updating estimated_tokens`);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/story_tasks?id=eq.${outlineTaskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_SECRET_KEY,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({
          estimated_tokens: estimatedTokensPreInsert,
          master_prompt: masterPrompt ? JSON.stringify(masterPrompt) : null,
          youtube_transcript: youtubeTranscript || null,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch (patchErr: any) {
      console.warn(`Non-fatal: failed to update pre-inserted task with estimated_tokens: ${patchErr.message}`);
    }
  }

  while (retries < MAX_RETRIES) {
    try {
      console.log(`Attempt ${retries + 1}`);

      // Different temperature based on model type
      const baseTemperature = validatedModel === 'deepseek' ? 0.8 : 0.7;
      const temperature = baseTemperature + (retries * 0.05);

      const response = await callModelWithTimeout(client, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ], {
        model: validatedModel === 'deepseek' ? "deepseek-reasoner" : validatedModel,
        max_tokens: 32000,
        temperature: temperature,
        stream: false,
      }, validatedModel);

      outlineText = response.choices[0].message.content;
      console.log(`Raw Output:\n${outlineText}\n`);

      if (!outlineText || outlineText.trim().length === 0) {
        throw new Error(`Invalid or empty outline received from ${validatedModel}`);
      }

      console.log(`Attempt ${retries + 1}: Outline generated, length: ${outlineText.length}`);

      // Sanitize markdown formatting from AI output before parsing
      outlineText = sanitizeOutlineOutput(outlineText, language);

      // Use the new language-aware parsing function
      const chapters = parseOutlineChapters(outlineText, language);

      console.log(`Parsed Chapters (${chapters.length}):`);
      for (const ch of chapters) {
        console.log(`- ${ch.index}${ch.part ? " " + ch.part : ""} (Logical: ${ch.logical_number}${ch.part ? " " + ch.part : ""}): ${ch.word_count} words`);
      }

      if (chapters.length === 0) {
        throw new Error(`Attempt ${retries + 1}: No valid chapters parsed`);
      }

      if (chapters.length < minBatches) {
        throw new Error(`Attempt ${retries + 1}: Insufficient chapters/parts parsed (${chapters.length} < ${minBatches})`);
      }

      const batchSection = outlineText.split("Batch Plan:")[1] || "";
      const batchLines = batchSection.trim().split("\n").filter(line => line.trim().startsWith("- Batch"));
      const numBatches = batchLines.length;

      console.log(`AI-Generated Batch Plan (${numBatches} batches):`, batchLines);

      const totalChapterWords = chapters.reduce((sum, ch) => sum + ch.word_count, 0);
      const assignedChapters = new Set<string>();
      const batchWordCounts: number[] = [];
      const invalidReferences: string[] = [];
      let validReferences = true;

      for (const line of batchLines) {
        const match = line.match(/- Batch \d+: Chapters \[([^\]]*)\], Total Words: (\d+)/);
        if (match) {
          const chaptersStr = match[1];
          const batchWords = parseInt(match[2]);
          batchWordCounts.push(batchWords);

          if (chaptersStr) {
            const refs = chaptersStr.split(",").map(ref => ref.trim()).filter(ref => ref);
            if (refs.length > 1) {
              validReferences = false;
              invalidReferences.push(`Multiple refs in ${line}`);
              console.log(`Invalid batch: ${line} contains multiple chapters/parts`);
            }

            for (const ref of refs) {
              const refMatch = ref.match(/(\d+)(?:\s*Part\s*(\d+))?/);
              if (refMatch) {
                const chapterNum = parseInt(refMatch[1]);
                const partNum = refMatch[2] ? `Part ${refMatch[2]}` : "";
                const found = chapters.some(ch => ch.logical_number === chapterNum && ch.part === partNum);
                if (!found) {
                  validReferences = false;
                  invalidReferences.push(ref);
                  console.log(`Invalid reference: ${ref} not found in chapters`);
                } else {
                  assignedChapters.add(`${chapterNum}${partNum ? " " + partNum : ""}`);
                }
              } else {
                validReferences = false;
                invalidReferences.push(`Unparsable ref: ${ref}`);
                console.log(`Failed to parse reference: ${ref}`);
              }
            }
          }
        } else {
          validReferences = false;
          invalidReferences.push(`Unparsable batch: ${line}`);
          console.log(`Failed to parse batch line: ${line}`);
        }
      }

      // Adjust validation tolerance based on word count
      const wordCountTolerance = sanitizedWordCount > 100000 ? 200 : (sanitizedWordCount > 10000 ? 200 : 200);

      const isValid = (
        Math.abs(totalChapterWords - sanitizedWordCount) <= wordCountTolerance &&
        numBatches === chapters.length &&
        !batchLines.some(line => line.includes("Chapters []")) &&
        assignedChapters.size === chapters.length &&
        validReferences &&
        batchWordCounts.reduce((sum, w) => sum + w, 0) === totalChapterWords &&
        !batchWordCounts.some(w => w > maxWordsPerBatch)
      );

      console.log(`Validation Check:`);
      console.log(`- Total Chapter Words: ${totalChapterWords} (Expected: ${sanitizedWordCount} ±${wordCountTolerance})`);
      console.log(`- Number of Batches: ${numBatches} (Expected: === ${chapters.length})`);
      console.log(`- Empty Batches: ${batchLines.some(line => line.includes("Chapters []"))}`);
      console.log(`- Assigned Chapters: ${assignedChapters.size} (Expected: === ${chapters.length})`);
      console.log(`- Valid References: ${validReferences}`);
      if (invalidReferences.length > 0) {
        console.log(`- Invalid References: ${invalidReferences}`);
      }
      console.log(`- Batch Word Counts Sum: ${batchWordCounts.reduce((sum, w) => sum + w, 0)} (Expected: === ${totalChapterWords})`);
      console.log(`- Any Batch > ${maxWordsPerBatch}: ${batchWordCounts.some(w => w > maxWordsPerBatch)}`);
      console.log(`- Plan Valid: ${isValid}`);

      if (isValid) {
        console.log(`Attempt ${retries + 1}: AI batch plan is valid.`);
      } else {
        console.log("Redistributing chapters...");

        // Fixed redistribution logic
        const wordDifference = sanitizedWordCount - totalChapterWords;
        
        if (Math.abs(wordDifference) > 0) {
          console.log(`Word difference: ${wordDifference} words. ${wordDifference > 0 ? 'Adding' : 'Removing'} words...`);
          
          if (wordDifference > 0) {
            // Need to add words
            const adjustableChapters = chapters.filter(ch => ch.word_count < maxWordsPerBatch);
            
            if (adjustableChapters.length > 0) {
              const wordsPerChapter = Math.floor(wordDifference / adjustableChapters.length);
              const remainingWords = wordDifference % adjustableChapters.length;
              
              for (let i = 0; i < adjustableChapters.length; i++) {
                const chapter = adjustableChapters[i];
                let additionalWords = wordsPerChapter;
                if (i < remainingWords) {
                  additionalWords += 1;
                }
                
                const maxAddition = maxWordsPerBatch - chapter.word_count;
                additionalWords = Math.min(additionalWords, maxAddition);
                
                chapter.word_count += additionalWords;
                console.log(`Added ${additionalWords} words to chapter ${chapter.logical_number}${chapter.part ? " " + chapter.part : ""}`);
              }
            }
          } else {
            // Need to remove words
            const adjustableChapters = chapters.filter(ch => ch.word_count > 300);
            const wordsToRemove = Math.abs(wordDifference);
            
            if (adjustableChapters.length > 0) {
              const wordsPerChapter = Math.floor(wordsToRemove / adjustableChapters.length);
              const remainingWords = wordsToRemove % adjustableChapters.length;
              
              for (let i = 0; i < adjustableChapters.length; i++) {
                const chapter = adjustableChapters[i];
                let wordsToSubtract = wordsPerChapter;
                if (i < remainingWords) {
                  wordsToSubtract += 1;
                }
                
                const maxSubtraction = chapter.word_count - 300;
                wordsToSubtract = Math.min(wordsToSubtract, maxSubtraction);
                
                chapter.word_count -= wordsToSubtract;
                console.log(`Removed ${wordsToSubtract} words from chapter ${chapter.logical_number}${chapter.part ? " " + chapter.part : ""}`);
              }
            }
          }
        }

        // Sort chapters by index for consistent ordering
        chapters.sort((a, b) => a.index - b.index);

        // Create new batch plan using exact logical numbering from parsed chapters
        const newBatchPlan: string[] = chapters.map((ch, idx) => {
          const chapterRef = `${ch.logical_number}${ch.part ? " " + ch.part : ""}`;
          return `- Batch ${idx + 1}: Chapters [${chapterRef}], Total Words: ${ch.word_count}`;
        });

        console.log(`DEBUG: Generated new batch plan:`);
        newBatchPlan.forEach((line, idx) => {
          const ch = chapters[idx];
          console.log(`  ${line} (Chapter index: ${ch.index}, logical: ${ch.logical_number}, part: ${ch.part || 'none'})`);
        });

        // Update outline text with redistributed word counts
        outlineText = updateOutlineTextWithRedistribution(outlineText, chapters, language);
        
        // Update the batch plan in the outline text
        const updatedBatchSection = "\n\nBatch Plan:\n" + newBatchPlan.join("\n");
        const chapterSection = outlineText.split("Batch Plan:")[0].trim();
        outlineText = chapterSection + updatedBatchSection;

        console.log("Redistributed Batch Plan:", newBatchPlan);

        const newTotalChapterWords = chapters.reduce((sum, ch) => sum + ch.word_count, 0);
        const newNumBatches = newBatchPlan.length;

        // Validate the new batch plan
        const newBatchWordCounts: number[] = [];
        const newAssignedChapters = new Set<string>();
        const newInvalidReferences: string[] = [];
        let newValidReferences = true;

        for (const line of newBatchPlan) {
          const match = line.match(/- Batch \d+: Chapters \[([^\]]*)\], Total Words: (\d+)/);
          if (match) {
            const chaptersStr = match[1];
            const batchWords = parseInt(match[2]);
            newBatchWordCounts.push(batchWords);

            const refs = chaptersStr.split(",").map(ref => ref.trim()).filter(ref => ref);
            if (refs.length !== 1) {
              newValidReferences = false;
              newInvalidReferences.push(`Invalid ref count in ${line}`);
              console.log(`Invalid redistributed batch: ${line} has ${refs.length} references`);
              continue;
            }

            const ref = refs[0];
            const refMatch = ref.match(/(\d+)(?:\s*Part\s*(\d+))?/);
            if (refMatch) {
              const chapterNum = parseInt(refMatch[1]);
              const partNum = refMatch[2] ? `Part ${refMatch[2]}` : "";
              const found = chapters.find(ch => ch.logical_number === chapterNum && ch.part === partNum);
              if (!found) {
                newValidReferences = false;
                newInvalidReferences.push(ref);
                console.log(`Invalid reference in redistributed plan: ${ref} - not found in chapters`);
                console.log(`Available chapters:`, chapters.map(ch => `${ch.logical_number}${ch.part ? " " + ch.part : ""}`));
              } else {
                newAssignedChapters.add(`${chapterNum}${partNum ? " " + partNum : ""}`);
              }
            } else {
              newValidReferences = false;
              newInvalidReferences.push(`Unparsable ref: ${ref}`);
              console.log(`Failed to parse redistributed reference: ${ref}`);
            }
          } else {
            newValidReferences = false;
            newInvalidReferences.push(`Unparsable batch: ${line}`);
            console.log(`Failed to parse redistributed batch line: ${line}`);
          }
        }

        const isValidAfterRedistribution = (
          Math.abs(newTotalChapterWords - sanitizedWordCount) <= wordCountTolerance &&
          newNumBatches === chapters.length &&
          !newBatchPlan.some(line => line.includes("Chapters []")) &&
          newAssignedChapters.size === chapters.length &&
          newValidReferences &&
          newBatchWordCounts.reduce((sum, w) => sum + w, 0) === newTotalChapterWords &&
          !newBatchWordCounts.some(w => w > maxWordsPerBatch)
        );

        console.log(`Redistribution Validation Check:`);
        console.log(`- Total Chapter Words: ${newTotalChapterWords} (Expected: ${sanitizedWordCount} ±${wordCountTolerance})`);
        console.log(`- Number of Batches: ${newNumBatches} (Expected: === ${chapters.length})`);
        console.log(`- Empty Batches: ${newBatchPlan.some(line => line.includes("Chapters []"))}`);
        console.log(`- Assigned Chapters: ${newAssignedChapters.size} (Expected: === ${chapters.length})`);
        console.log(`- Valid References: ${newValidReferences}`);
        if (newInvalidReferences.length > 0) {
          console.log(`- Invalid References: ${newInvalidReferences}`);
        }
        console.log(`- Batch Word Counts Sum: ${newBatchWordCounts.reduce((sum, w) => sum + w, 0)} (Expected: === ${newTotalChapterWords})`);
        console.log(`- Any Batch > ${maxWordsPerBatch}: ${newBatchWordCounts.some(w => w > maxWordsPerBatch)}`);
        console.log(`- Plan Valid: ${isValidAfterRedistribution}`);

        if (!isValidAfterRedistribution) {
          throw new Error(`Attempt ${retries + 1}: Redistributed plan invalid: ${newInvalidReferences.join(", ")}`);
        }
      }

      inputTokens = response.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
      outputTokens = response.usage?.completion_tokens || estimateTokens(outlineText);

      // Apply token multiplier for cost normalization (legacy vs new plan)
      const isLegacyPlan = await getIsLegacyPlan(userId);
      const tokenMultiplier = llmMultiplier(isLegacyPlan, validatedModel);
      const adjustedInputTokens = Math.round(inputTokens * tokenMultiplier);
      const adjustedOutputTokens = Math.round(outputTokens * tokenMultiplier);

      // Calculate estimated tokens for this story generation
      const estimatedTokens = calculateEstimatedTokens(sanitizedWordCount, validatedModel, false, isLegacyPlan);
      
      // Update the pre-inserted processing row to completed
      const updatePayload = {
        previous_content: outlineText,
        progress: 100,
        status: "completed",
        outline: outlineText,
        total_batches: chapters.length,
        updated_at: new Date().toISOString(),
        input_tokens: adjustedInputTokens,
        output_tokens: adjustedOutputTokens,
        estimated_tokens: estimatedTokens,
        youtube_transcript: youtubeTranscript || null,
        content_type: contentType,
      };

      const updateResponse = await fetch(
        `${SUPABASE_URL}/rest/v1/story_tasks?id=eq.${outlineTaskId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SECRET_KEY,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify(updatePayload),
        }
      );

      if (!updateResponse.ok) {
        const updateError = await updateResponse.text().catch(() => 'Unknown error');
        console.warn(`Failed to update processing task to completed: HTTP ${updateResponse.status} - ${updateError}`);
        // Fall back to insert if the pre-inserted row was lost
        const outlineTask = {
          id: crypto.randomUUID(),
          user_id: userId,
          group_id: groupId,
          batch: [],
          previous_content: outlineText,
          total_word_count: sanitizedWordCount,
          batch_number: 0,
          progress: 100,
          status: "completed",
          story_title: title,
          description: description,
          outline: outlineText,
          total_batches: chapters.length,
          is_corrected: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          input_tokens: adjustedInputTokens,
          output_tokens: adjustedOutputTokens,
          variant: finalVariant,
          stop_requested: false,
          video_process: videoProcess,
          language: language,
          model: validatedModel,
          tab: tab,
          estimated_tokens: estimatedTokens,
          master_prompt: masterPrompt ? JSON.stringify(masterPrompt) : null,
          pauses: pauses || false,
          youtube_transcript: youtubeTranscript || null,
          content_type: contentType,
        };

        const fallbackInsert = await fetch(`${SUPABASE_URL}/rest/v1/story_tasks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": SUPABASE_SECRET_KEY,
            "Prefer": "resolution=ignore-duplicates",
          },
          body: JSON.stringify(outlineTask),
        });

        if (!fallbackInsert.ok) {
          const fallbackError = await fallbackInsert.text().catch(() => 'Unknown error');
          if (!fallbackError.includes('duplicate') && !fallbackError.includes('unique constraint')) {
            throw new Error(`Failed to save outline task: HTTP ${fallbackInsert.status} - ${fallbackError}`);
          }
        }
      } else {
        console.log(`Updated outline task ${outlineTaskId} to completed for group ${groupId}, tab ${tab}`);
      }

      triggerParseFunction(groupId, userId, title, description, sanitizedWordCount, language, validatedModel, tab, finalVariant, pauses)
        .catch((error) => {
          console.error(`Background trigger of storyscriptai-parse failed: ${error.message}`);
        });

      console.log(`Final Outline:\n${outlineText}\n`);
      
      // Record success in circuit breaker
      recordCircuitBreakerSuccess(validatedModel);
      
      return [outlineText, adjustedInputTokens, adjustedOutputTokens];
    } catch (error: any) {
      console.error(`Attempt ${retries + 1} failed:`, error.message);
      
      // Record failure in circuit breaker
      recordCircuitBreakerFailure(validatedModel);
      
      retries++;
      if (retries >= MAX_RETRIES) {
        // Update the pre-inserted processing row to error status
        try {
          await fetch(
            `${SUPABASE_URL}/rest/v1/story_tasks?id=eq.${outlineTaskId}`,
            {
              method: "PATCH",
              headers: {
                "Content-Type": "application/json",
                "apikey": SUPABASE_SECRET_KEY,
                "Prefer": "return=minimal",
              },
              body: JSON.stringify({
                status: "error",
                progress: 0,
                updated_at: new Date().toISOString(),
              }),
            }
          );
          console.log(`Updated outline task ${outlineTaskId} to error status`);
        } catch (updateErr: any) {
          console.warn(`Failed to update outline task to error: ${updateErr.message}`);
        }
        throw new Error(`Failed to generate outline after ${MAX_RETRIES} attempts: ${error.message}`);
      }
      console.warn(`Retry ${retries}/${MAX_RETRIES} for outline generation: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error("Unexpected error in outline generation");
}

// Helper function to build master prompt enhancement
function buildMasterPromptEnhancement(masterPrompt: any, description: string): string {
  if (!masterPrompt) {
    return description;
  }

  let enhancement = description + "\n\n=== MASTER PROMPT CONTEXT ===\n\n";
  
  if (masterPrompt.visualStyle && masterPrompt.visualStyle.trim()) {
    enhancement += `VISUAL STYLE & COLORS:\n${masterPrompt.visualStyle.trim()}\n\n`;
  }
  
  if (masterPrompt.setting && masterPrompt.setting.trim()) {
    enhancement += `SETTING & TIME PERIOD:\n${masterPrompt.setting.trim()}\n\n`;
  }
  
  if (masterPrompt.atmosphere && masterPrompt.atmosphere.trim()) {
    enhancement += `ATMOSPHERE & MOOD:\n${masterPrompt.atmosphere.trim()}\n\n`;
  }

  if (masterPrompt.narrativeStructure && masterPrompt.narrativeStructure.trim()) {
    enhancement += `NARRATIVE STRUCTURE (follow this blueprint closely):\n${masterPrompt.narrativeStructure.trim()}\n\n`;
  }

  if (masterPrompt.tonalGuidelines && masterPrompt.tonalGuidelines.trim()) {
    enhancement += `TONAL GUIDELINES (match this prose style exactly):\n${masterPrompt.tonalGuidelines.trim()}\n\n`;
  }

  if (masterPrompt.consistencyNotes && masterPrompt.consistencyNotes.trim()) {
    enhancement += `CONSISTENCY NOTES:\n${masterPrompt.consistencyNotes.trim()}\n\n`;
  }
  
  // Add environment-only mode instructions
  if (masterPrompt.environmentOnly === true) {
    enhancement += `ENVIRONMENT ONLY MODE: CRITICAL INSTRUCTION\n`;
    enhancement += `This story must focus EXCLUSIVELY on environments, places, atmospheres, and settings.\n`;
    enhancement += `DO NOT include any human or sentient characters in the outline or story.\n`;
    enhancement += `DO NOT create named individuals, protagonists, or character descriptions.\n`;
    enhancement += `Focus on: architecture, landscapes, weather, lighting, spaces, objects, and atmosphere.\n`;
    enhancement += `The story should be a visual and sensory journey through places, not about people.\n\n`;
  } else if (masterPrompt.characters && Array.isArray(masterPrompt.characters)) {
    const validCharacters = masterPrompt.characters.filter((char: any) => 
      char && (char.name?.trim() || char.description?.trim())
    );
    
    if (validCharacters.length > 0) {
      enhancement += `CHARACTER DESCRIPTIONS:\n`;
      validCharacters.forEach((char: any, index: number) => {
        const name = char.name?.trim() || 'Unnamed Character';
        enhancement += `\n${index + 1}. ${name}:\n`;
        if (char.description?.trim()) {
          enhancement += `   ${char.description.trim()}\n`;
        }
        if (char.personality?.trim()) {
          enhancement += `   Personality: ${char.personality.trim()}\n`;
        }
        if (char.appearance?.trim()) {
          enhancement += `   Appearance: ${char.appearance.trim()}\n`;
        }
        if (char.role?.trim()) {
          enhancement += `   Role: ${char.role.trim()}\n`;
        }
      });
      enhancement += "\n";
    }
  }
  
  enhancement += "=== END MASTER PROMPT CONTEXT ===\n\n";
  
  if (masterPrompt.environmentOnly === true) {
    enhancement += "REMINDER: This is ENVIRONMENT ONLY MODE. Do not include characters. Focus solely on places, atmospheres, and visual environments in your outline and story generation.";
  } else {
    enhancement += "Please incorporate all of the above context into the story outline and generation.";
  }
  
  return enhancement;
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

// Fire-and-forget self-call. Re-posts the original request body with
// `_retryAttempt` incremented so the next invocation can decide whether to
// keep retrying or stop silently. Intentionally does NOT touch the database
// (no error_message / status writes) so the row simply stays in `processing`
// until a future attempt completes — matching the requested behavior of
// "just call itself, no error state, give up silently at 5".
async function triggerSelfRetry(originalBody: any, nextAttempt: number) {
  try {
    const retryBody = { ...originalBody, _retryAttempt: nextAttempt };
    console.log(
      `[self-retry] scheduling attempt ${nextAttempt}/${MAX_SELF_RETRIES} for group ${originalBody?.groupId}, tab ${originalBody?.tab ?? 1}`,
    );
    // Fire and forget — do not await the body, just the dispatch.
    fetch(SELF_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SECRET_KEY,
      },
      body: JSON.stringify(retryBody),
    })
      .then((r) => {
        console.log(`[self-retry] attempt ${nextAttempt} dispatched, status ${r.status}`);
      })
      .catch((err) => {
        console.error(`[self-retry] dispatch failed: ${err?.message || err}`);
      });
  } catch (err: any) {
    console.error(`[self-retry] unexpected error: ${err?.message || err}`);
  }
}

Deno.serve(async (req: Request) => {
  const corsOrigin = getCorsOrigin(req);
  // Add request timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.error("Request timeout - aborting");
    controller.abort();
  }, REQUEST_TIMEOUT);

  let requestBody: any = null;

  try {
    if (req.method === "OPTIONS") {
      clearTimeout(timeoutId);
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
      clearTimeout(timeoutId);
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: {
          "Content-Type": "application/json",
          'Access-Control-Allow-Origin': corsOrigin,
        },
      });
    }

    // If the isolate booted without required env, return a logged 500
    // (instead of crashing the module and producing an unlogged 500).
    if (ENV_BOOT_ERROR) {
      clearTimeout(timeoutId);
      console.error(`[storyscriptai-outline] rejecting request: ${ENV_BOOT_ERROR}`);
      return new Response(JSON.stringify({ error: ENV_BOOT_ERROR }), {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          'Access-Control-Allow-Origin': corsOrigin,
        },
      });
    }

    requestBody = await req.json();

    // Verify authentication
    const _authHeader = req.headers.get('Authorization');
    const _authToken = _authHeader?.startsWith('Bearer ') ? _authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!_authToken) {
      clearTimeout(timeoutId);
      return new Response(JSON.stringify({ error: 'Missing authorization' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }    // authToken resolved above (Bearer or apikey)
    const _secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || '';
    const _publicKey = Deno.env.get('SUPABASE_PUBLIC_KEY') || '';
    const _allowedKeys = [_secretKey, _publicKey].filter(Boolean);
    let _authenticatedUserId: string | null = null;

    if (_allowedKeys.includes(_authToken)) {
      // Service or frontend call (legacy or new keys)
    } else {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(_authToken);
      if (_authErr || !_authUser) {
        clearTimeout(timeoutId);
        return new Response(JSON.stringify({ error: 'Invalid or expired token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
        });
      }
      _authenticatedUserId = _authUser.id;
    }

    // When JWT auth is used, override body userId with authenticated user
    if (_authenticatedUserId && requestBody.userId) {
      requestBody.userId = _authenticatedUserId;
    }

    const { 
      title, 
      description, 
      wordCount, 
      groupId, 
      userId, 
      videoProcess = false, 
      language = 'english', 
      model = 'sonnet', 
      _retryAttempt, 
      tab = 1,
      master_prompt = null,
      is_runtime_mode = false,
      runtime_minutes = null,
      pauses = false,
      youtube_transcript = null,
      outline_task_id = null
    } = requestBody;

    if (!title || !description || !wordCount || !groupId || !userId) {
      clearTimeout(timeoutId);
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          'Access-Control-Allow-Origin': corsOrigin,
        },
      });
    }

    // Validate language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language) ? language : 'english';

    // Validate model
    const supportedModels = ['deepseek', 'sonnet', 'opus'];
    const validatedModel = supportedModels.includes(model) ? model : 'sonnet';

    console.log(`Received outline request with videoProcess: ${videoProcess}, language: ${validatedLanguage}, model: ${validatedModel}, tab: ${tab}, retryAttempt: ${_retryAttempt || 'initial'}, master_prompt: ${master_prompt ? 'enabled' : 'disabled'}`);

    // Normalize the self-retry counter. Initial calls have no _retryAttempt
    // (treated as 0). Each self-call increments it. Once we hit the cap we
    // bail out silently — no DB writes, no error status — exactly as
    // requested.
    const currentAttempt = Number.isFinite(Number(_retryAttempt)) ? Number(_retryAttempt) : 0;
    if (currentAttempt >= MAX_SELF_RETRIES) {
      console.log(
        `[self-retry] reached MAX_SELF_RETRIES (${MAX_SELF_RETRIES}) for group ${groupId}, tab ${tab} — giving up silently`,
      );
      clearTimeout(timeoutId);
      return new Response(JSON.stringify({ ok: true, silentGiveUp: true, attempt: currentAttempt }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
      });
    }

    // Enhance description with master prompt if provided
    const enhancedDescription = master_prompt ? buildMasterPromptEnhancement(master_prompt, description) : description;

    const [outlineText, inputTokens, outputTokens] = await generateOutline(
      title,
      enhancedDescription,
      wordCount,
      groupId,
      userId,
      videoProcess,
      validatedLanguage,
      validatedModel,
      tab,
      master_prompt,
      pauses,
      youtube_transcript,
      outline_task_id
    );

    clearTimeout(timeoutId);
    return new Response(JSON.stringify({ outline: outlineText, inputTokens, outputTokens, videoProcess, language: validatedLanguage, model: validatedModel, tab }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    console.error("Error generating outline:", error.message);

    // Self-retry strategy (replaces the old retryOutlineAsync + error_message
    // writes). Whatever went wrong — timeout, parse failure, AI error, even an
    // outright hung isolate that lets the next attempt land here — we just
    // fire a fresh POST to ourselves with _retryAttempt incremented. We do
    // NOT write status='error' / error_message anywhere, and at attempt 5 we
    // simply stop (matching the behavior the user asked for).
    const attemptForRetry = (requestBody && Number.isFinite(Number(requestBody._retryAttempt)))
      ? Number(requestBody._retryAttempt)
      : 0;
    const nextAttempt = attemptForRetry + 1;
    if (requestBody && requestBody.groupId && requestBody.userId && nextAttempt < MAX_SELF_RETRIES) {
      await triggerSelfRetry(requestBody, nextAttempt);
    } else if (requestBody && nextAttempt >= MAX_SELF_RETRIES) {
      console.log(
        `[self-retry] not retrying group ${requestBody.groupId} — already at attempt ${attemptForRetry}, cap is ${MAX_SELF_RETRIES}`,
      );
    }

    return new Response(JSON.stringify({
      error: error.message,
      retrying: !!(requestBody && requestBody.groupId && nextAttempt < MAX_SELF_RETRIES),
      attempt: attemptForRetry,
      nextAttempt: nextAttempt < MAX_SELF_RETRIES ? nextAttempt : null,
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        'Access-Control-Allow-Origin': corsOrigin,
      },
    });
  }
}, { port: 8000 });




