import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { verifyAuth, supabase } from '../_shared/utils.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const TOKEN_PER_WORD = 1.33;

// Model configurations
const MODEL_CONFIGS = {
  deepseek: {
    apiKey: deepseekApiKey,
    baseURL: 'https://api.deepseek.com',
    tokenMultiplier: 1.0
  },
  sonnet: {
    apiKey: anthropicApiKey,
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 11.0
  },
  opus: {
    apiKey: anthropicApiKey,
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 19.0
  }
};

// Enhanced character normalization function
function normalizeText(text: string): string {
  if (!text) return text;
  // Strip SSML break tags (well-formed, malformed, and incomplete)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');
 
  // Step 1: Handle corrupted/mojibake characters first
  let normalized = text
    // Handle common corrupted character sequences
    .replace(/�/g, "'") // Replace generic replacement character
    .replace(/â€™/g, "'") // Common mojibake for right single quotation
    .replace(/â€œ/g, '"') // Common mojibake for left double quotation
    .replace(/â€�/g, '"') // Common mojibake for right double quotation
    .replace(/â€"/g, '—') // Common mojibake for em dash
    .replace(/â€"/g, '–') // Common mojibake for en dash
    .replace(/â€¦/g, '…') // Common mojibake for ellipsis
    // Handle other common mojibake patterns
    .replace(/Ã¢â‚¬â„¢/g, "'")
    .replace(/Ã¢â‚¬Å"/g, '"')
    .replace(/Ã¢â‚¬Â/g, '"')
    .replace(/Ã¢â‚¬â€œ/g, '—');

  // Step 2: Normalize Unicode characters but preserve em/en dashes
  normalized = normalized
    // Various apostrophes and single quotes - including the problematic one
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A]/g, "'")
    // Specific handling for the problematic curly apostrophe
    .replace(/'/g, "'") // Right single quotation mark
    .replace(/'/g, "'") // Left single quotation mark
    // Various double quotes
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/"/g, '"') // Left double quotation mark
    .replace(/"/g, '"') // Right double quotation mark
    // Dashes - PRESERVE em dash and en dash for exact matching
    .replace(/[\u2010\u2011\u2012]/g, '-') // Convert hyphens to regular hyphen
    // Keep en dash as en dash: \u2013 → –
    // Keep em dash as em dash: \u2014 → —
    .replace(/\u2015/g, '—') // Convert horizontal bar to em dash
    // Ellipsis
    .replace(/\u2026/g, '...')
    // Other common Unicode punctuation
    .replace(/\u00A0/g, ' '); // Non-breaking space

  // Step 3: Handle Unicode escape sequences in strings
  try {
    // This will handle cases where we have literal \u sequences
    normalized = normalized.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
      const codePoint = parseInt(hex, 16);
      const char = String.fromCharCode(codePoint);
     
      // Map common Unicode characters but preserve em/en dashes
      switch (codePoint) {
        case 0x2018: case 0x2019: case 0x201A: case 0x201B: // Various single quotes
          return "'";
        case 0x201C: case 0x201D: case 0x201E: case 0x201F: // Various double quotes
          return '"';
        case 0x2013: // En dash - keep as is
          return '–';
        case 0x2014: // Em dash - keep as is
          return '—';
        case 0x2015: // Horizontal bar - convert to em dash
          return '—';
        case 0x2026: // Ellipsis
          return '...';
        case 0x00A0: // Non-breaking space
          return ' ';
        default:
          return char;
      }
    });
  } catch (e) {
    // If Unicode escape replacement fails, continue with the text as-is
    console.warn('Unicode escape sequence replacement failed:', e);
  }

  // Step 4: Clean up any remaining problematic characters
  normalized = normalized
    // Remove or replace any remaining control characters except newlines and tabs
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize line endings
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Clean up multiple spaces (but preserve intentional formatting)
    .replace(/[ \t]+/g, ' ')
    // Trim whitespace from lines but preserve paragraph breaks
    .split('\n').map(line => line.trim()).join('\n')
    // Clean up multiple consecutive newlines (max 2)
    .replace(/\n{3,}/g, '\n\n');

  return normalized;
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const errorDetails = error?.message || error?.toString() || JSON.stringify(error) || 'Unknown error';
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message: message || 'Unknown error message',
        details: errorDetails,
        error_message: errorDetails,
        created_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(word => word.length > 0).length * TOKEN_PER_WORD);
}

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]?.tokenMultiplier || 1.0;
}

interface RequestBody {
  batch_segments: Array<{ text: string; start: number; is_first_page: boolean }>;
  text_part: string;
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    firstPageFrequency: string;
    restFrequency: string;
  };
  use_character_descriptions: boolean;
  characters?: Record<string, string>;
  language?: string;
  model?: string;
  task_id: string; // Required: To fetch context and previous prompts
  group_id: string; // Required: To fetch full story context
}

interface PromptResult {
  text: string;
  original_text?: string;
  structured_text?: string;
  prompt: string;
  characters_mentioned?: string[];
}

function validateInputs(data: RequestBody): string | null {
  if (!data.batch_segments || !Array.isArray(data.batch_segments) || data.batch_segments.length === 0) return 'Missing or empty batch_segments';
  if (typeof data.text_part !== 'string' || data.text_part.length === 0) return 'Missing or empty text_part';
  if (!data.settings || typeof data.settings !== 'object') return 'Missing or invalid settings';
  if (typeof data.use_character_descriptions !== 'boolean') return 'Missing or invalid use_character_descriptions';
  if (data.use_character_descriptions && (!data.characters || typeof data.characters !== 'object')) return 'Missing or invalid characters when use_character_descriptions is true';

  for (const segment of data.batch_segments) {
    if (typeof segment.text !== 'string' || segment.text.length === 0) return 'Invalid segment: empty text';
    if (typeof segment.start !== 'number' || segment.start < 0) return 'Invalid segment: invalid start position';
    if (typeof segment.is_first_page !== 'boolean') return 'Invalid segment: invalid is_first_page';
  }

  return null;
}

// Create model client
function createModelClient(model: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) {
    throw new Error(`Unsupported model: ${model}`);
  }
 
  if (!config.apiKey) {
    throw new Error(`API key not set for model: ${model}`);
  }

  return config;
}

// Call model API
async function callModelAPI(config: any, messages: any[], options: any, model: string) {
  if (model === 'deepseek') {
    const response = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        max_tokens: options.max_tokens || 8000,
        temperature: options.temperature || 0.6,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${errorText}`);
    }

    let content = '';
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; // Buffer for incomplete SSE lines across chunks

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);
            if (data === '[DONE]') break;
           
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                content += parsed.choices[0].delta.content;
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          }
        }
      }
    }

    return {
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: estimateTokens(messages.map(m => m.content).join('')),
        completion_tokens: estimateTokens(content)
      }
    };
  } else {
    const anthropicMessages = messages.slice(1).map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
        max_tokens: options.max_tokens || 16000,
        temperature: options.temperature || 0.4,
        system: messages[0].content,
        messages: anthropicMessages
      })
    });
   
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: HTTP ${response.status} - ${errorText}`);
    }
   
    const result = await response.json();
    const contentBlocks = Array.isArray(result?.content) ? result.content : [];
    const textContent = contentBlocks
      .filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
      .map((block: any) => block.text)
      .join('')
      .trim();

    if (!textContent) {
      const blockTypes = contentBlocks.map((block: any) => block?.type || 'unknown').join(', ') || 'none';
      throw new Error(`Anthropic API returned no text content (stop_reason=${result?.stop_reason || 'unknown'}, content_blocks=${blockTypes})`);
    }
   
    return {
      choices: [{ message: { content: textContent } }],
      usage: {
        prompt_tokens: result.usage?.input_tokens || 0,
        completion_tokens: result.usage?.output_tokens || 0
      }
    };
  }
}

// Enhanced JSON cleaning function
function cleanAndParseJSON(jsonString: string): any {
  // Fix invalid backslash escapes produced by AI (e.g. \s, \T, \l, \c).
  // Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX — anything else is illegal.
  const fixBackslashes = (str: string) => str.replace(/\\(?!["\\/bfnrtu])/g, '');

  try {
    return JSON.parse(jsonString);
  } catch (error) {
    console.log('Initial JSON parse failed, attempting to clean...');
   
    let cleaned = jsonString.trim();

    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
   
    try {
      return JSON.parse(cleaned);
    } catch (_) { /* fall through */ }

    // Try fixing invalid backslash escapes
    try {
      return JSON.parse(fixBackslashes(cleaned));
    } catch (error2) {
      console.log('Basic cleanup failed, attempting enhanced regex fix...');
     
      let simpleFix = cleaned;
     
      // Replace curly quotes with straight quotes first
      simpleFix = simpleFix.replace(/\u201C/g, '"').replace(/\u201D/g, '"');
     
      // Handle Unicode escape sequences in the JSON
      simpleFix = simpleFix.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
        const codePoint = parseInt(hex, 16);
        switch (codePoint) {
          case 0x2018: case 0x2019: case 0x201A: case 0x201B:
            return "'";
          case 0x201C: case 0x201D: case 0x201E: case 0x201F:
            return '"';
          case 0x2013: case 0x2014: case 0x2015:
            return '-';
          case 0x2026:
            return '...';
          case 0x00A0:
            return ' ';
          default:
            return String.fromCharCode(codePoint);
        }
      });
     
      const targetFields = ['original_text', 'structured_text', 'prompt', 'text'];
     
      for (const fieldName of targetFields) {
        const pattern = new RegExp(
          `("${fieldName}"\\s*:\\s*")([^"]*(?:"[^"]*"[^"]*)*?)("\\s*[,}\\]])`,
          'g'
        );
       
        simpleFix = simpleFix.replace(pattern, (match, fieldStart, fieldContent, fieldEnd) => {
          const fixedContent = fieldContent.replace(/"/g, '\\"');
          return `${fieldStart}${fixedContent}${fieldEnd}`;
        });
      }

      // Fix invalid backslash escapes after other fixes
      simpleFix = fixBackslashes(simpleFix);
     
      try {
        return JSON.parse(simpleFix);
      } catch (error3) {
        console.error('All JSON cleaning attempts failed');
        throw new Error(`Failed to parse JSON after cleaning attempts: ${error3.message}`);
      }
    }
  }
}

function extractPromptsFromBatchOutput(batchOutput: string | null | undefined): string[] {
  if (!batchOutput || typeof batchOutput !== 'string') return [];

  // New-format output: JSON array with { prompt } objects.
  try {
    const parsed = JSON.parse(batchOutput);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item: any) => (typeof item?.prompt === 'string' ? item.prompt.trim() : ''))
        .filter((p: string) => p.length > 0);
    }
  } catch {
    // Fall through to legacy parser.
  }

  // Legacy format from process-image-batch:
  // [segment text]
  // [Image Prompt: ...]
  const prompts: string[] = [];
  const promptRegex = /\[Image Prompt:\s*([\s\S]*?)\]\s*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = promptRegex.exec(batchOutput)) !== null) {
    const prompt = (match[1] || '').trim();
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

function extractWords(text: string): string[] {
  return text.match(/\b\w+\b/g) || [];
}

// Format character descriptions in JSON key-value format
function formatCharacterDescriptions(characters: Record<string, string> | null | undefined): string {
  if (!characters || Object.keys(characters).length === 0) {
    return '\n\n⚠️ CRITICAL REQUIREMENT: This image must NOT contain any text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, speech bubbles, or any readable characters whatsoever.';
  }
  
  const charLines: string[] = [];
  for (const [name, description] of Object.entries(characters)) {
    charLines.push(`  "${name}": "${description}"`);
  }
  
  return '\nCharacter Descriptions:\n{\n' + charLines.join(',\n') + '\n}\n\n⚠️ CRITICAL REQUIREMENT: This image must NOT contain any text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, speech bubbles, or any readable characters whatsoever.';
}

// Filter character descriptions to only include mentioned characters
function filterCharacterDescriptions(
  characters: Record<string, string> | null | undefined,
  mentionedNames: string[] | null | undefined
): Record<string, string> {
  if (!characters || !mentionedNames || mentionedNames.length === 0) return {};
  const matched: Record<string, string> = {};
  const charEntries = Object.entries(characters);
  for (const mentioned of mentionedNames) {
    const mentionedLower = mentioned.toLowerCase();
    for (const [name, desc] of charEntries) {
      const nameLower = name.toLowerCase();
      if (nameLower === mentionedLower || nameLower.includes(mentionedLower) || mentionedLower.includes(nameLower)) {
        matched[name] = desc;
      }
    }
  }
  return matched;
}

// Fetch full story context from image_prompt_context table
async function fetchFullContext(groupId: string, partNumber: number = 1) {
  console.log(`Fetching context for group ${groupId}, part ${partNumber}`);
  
  const { data: context, error } = await supabase
    .from('image_prompt_context')
    .select('*')
    .eq('group_id', groupId)
    .eq('part_number', partNumber)
    .single();
    
  if (error || !context) {
    console.log(`No context found for part ${partNumber}, trying legacy mode (no part_number)`);
    // Fallback for old data without part_number
    const { data: legacyContext, error: legacyError } = await supabase
      .from('image_prompt_context')
      .select('*')
      .eq('group_id', groupId)
      .is('part_number', null)
      .single();
    
    if (legacyError || !legacyContext) {
      console.log('No legacy context found either');
      return null;
    }
    
    return legacyContext;
  }
  
  console.log(`Successfully fetched context part ${partNumber}: ${context.full_story_text?.length || 0} chars`);
  return context;
}

// Get system prompt with full story context
function getSystemPrompts(
  language: string,
  style: string,
  characters: Record<string, string>,
  environmentOnlyMode: boolean,
  fullStoryContext: string,
  previousPrompts: string[]
): string {
  
  const hasChars = characters && Object.keys(characters).length > 0;
  const charReferenceBlock = hasChars
    ? '\nCharacter Reference (use ONLY these names when characters appear in a scene):\n' +
      JSON.stringify(characters, null, 2) + '\n'
    : '';
  const schemaInstruction = hasChars
    ? ', and "characters_mentioned" (a JSON array of character name strings that appear in this scene — use the exact keys from the Character Reference above; empty array [] if no characters)'
    : '';
  const charSystemInstruction = hasChars
    ? '\n- When mentioning characters, use their name from the Character Reference. The matching full character descriptions will be automatically appended to your prompt after generation.'
    : '';

  const characterDescriptions = Object.entries(characters || {})
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join('\n');
  
  const contextSection = `
Full Story Context (for consistency and understanding):
${fullStoryContext.slice(0, 15000)}

${previousPrompts.length > 0 ? `
Previous Image Prompts for Consistency:
${previousPrompts.slice(-5).map((p, i) => `${i + 1}. ${p.slice(0, 200)}...`).join('\n')}
` : ''}
`;

  const prompts = {
    english: `You are an expert visual storyteller. Generate detailed 200-300 word image prompts for each text segment.

CRITICAL INSTRUCTION: For EACH segment, you will receive:
- "Text to copy: [exact story text]"

You MUST return an object with two fields for each segment:
1. "text": Copy the EXACT text that appears after "Text to copy:" - WORD-FOR-WORD with every character, space, and punctuation mark exactly as provided
2. "prompt": Your generated 200-300 word detailed image prompt

ABSOLUTE RULES - VIOLATION WILL CAUSE SYSTEM FAILURE:
- Create EXACTLY ONE image prompt per segment - NO MORE, NO LESS
- If you receive 1 segment, return EXACTLY 1 result
- If you receive 2 segments, return EXACTLY 2 results
- If you receive 5 segments, return EXACTLY 5 results
- NEVER EVER split a segment into multiple prompts, even if it contains many paragraphs, multiple scenes, or transitions
- Each "Segment N:" block represents ONE AND ONLY ONE image prompt, regardless of how long the text is
- If a segment contains multiple scenes (e.g., dawn then storm, or character then environment), you MUST create ONE SINGLE PROMPT that either:
  a) Captures the most visually striking or important moment, OR
  b) Creates a composite/transition scene that shows the progression
- NEVER output more results than input segments - this is the most critical rule
- Copy the ENTIRE text EXACTLY from after "Text to copy:" - do not summarize, split, or modify
- Use the full story context and previous prompts to ensure visual consistency across scenes
- Focus on visual details, composition, lighting, emotions, and atmosphere
- Style requirements: ${style}
${environmentOnlyMode ? `- ENVIRONMENT-ONLY MODE: Focus on places, objects, and atmosphere. Avoid showing character faces or detailed character focus. Use locations as the main subject.` : ''}
${charSystemInstruction}
${charReferenceBlock}
WARNING: Long text segments (600+ seconds) may contain multiple narrative sections. You MUST still create only ONE prompt per segment. Choose the most cinematic moment or create a transition/composite image.

Output a JSON array with exactly the same number of items as input segments. Each item MUST have 'text' (exact verbatim copy from after "Text to copy:"), 'prompt' (your 200-300 word description)${schemaInstruction} keys. Return only the JSON array.

Example for 1 segment input (must return exactly 1 result):
[
  {
    "text": "[Exact copy of everything after 'Text to copy:' for segment 1]",
    "prompt": "A richly detailed 200-300 word image generation prompt describing the visual scene..."${hasChars ? ',\n    "characters_mentioned": ["Character Name"]' : ''}
  }
]

${contextSection}`,

    german: `Sie sind ein Experte für visuelles Geschichtenerzählen. Generieren Sie detaillierte 200-300-Wort-Bildprompts für jedes Textsegment.

KRITISCHE ANWEISUNG: Für JEDES Segment erhalten Sie:
- "Text to copy: [exakter Story-Text]"

Sie MÜSSEN ein Objekt mit zwei Feldern für jedes Segment zurückgeben:
1. "text": Kopieren Sie den EXAKTEN Text nach "Text to copy:" - WORT FÜR WORT mit jedem Zeichen, Leerzeichen und Satzzeichen genau wie angegeben
2. "prompt": Ihr generierter detaillierter 200-300-Wort-Bildprompt

WICHTIG:
- Erstellen Sie genau EINEN Bildprompt für jedes Textsegment
- Kopieren Sie den Text EXAKT nach "Text to copy:" - nicht zusammenfassen, paraphrasieren oder ändern
- Verwenden Sie den vollständigen Story-Kontext für visuelle Konsistenz
- Fokus auf visuelle Details, Komposition, Beleuchtung, Emotionen und Atmosphäre
- Style-Anforderungen: ${style}
${environmentOnlyMode ? `- UMGEBUNGS-ONLY-MODUS: Fokus auf Orte, Objekte und Atmosphäre. Vermeiden Sie Charaktergesichter.` : ''}
${charSystemInstruction}
${charReferenceBlock}
Ausgabe: JSON-Array mit genau der gleichen Anzahl wie Eingabesegmente. Jedes Element MUSS Schlüssel haben: 'text' (exakte Kopie nach "Text to copy:"), 'prompt' (Ihre 200-300-Wort-Beschreibung)${schemaInstruction}.

${contextSection}`,

    spanish: `Eres un experto narrador visual. Genera prompts de imagen detallados de 200-300 palabras para cada segmento de texto.

INSTRUCCIÓN CRÍTICA: Para CADA segmento, recibirás:
- "Text to copy: [texto exacto de la historia]"

DEBES devolver un objeto con dos campos para cada segmento:
1. "text": Copia el texto EXACTO que aparece después de "Text to copy:" - PALABRA POR PALABRA con cada carácter, espacio y puntuación exactamente como se proporciona
2. "prompt": Tu prompt de imagen detallado generado de 200-300 palabras

IMPORTANTE:
- Crea exactamente UN prompt de imagen para cada segmento
- Copia el texto EXACTAMENTE después de "Text to copy:" - no resumas, parafrasees o modifiques
- Usa el contexto completo de la historia para consistencia visual
- Enfócate en detalles visuales, composición, iluminación, emociones y atmósfera
- Requisitos de estilo: ${style}
${environmentOnlyMode ? `- MODO SOLO-AMBIENTE: Enfoque en lugares, objetos y atmósfera. Evita mostrar caras de personajes.` : ''}
${charSystemInstruction}
${charReferenceBlock}
Salida: Array JSON con exactamente el mismo número de elementos que segmentos de entrada. Cada elemento DEBE tener claves: 'text' (copia literal exacta), 'prompt' (tu descripción de 200-300 palabras)${schemaInstruction}.

${contextSection}`,

    french: `Vous êtes un expert en narration visuelle. Générez des prompts d'image détaillés de 200-300 mots pour chaque segment de texte.

INSTRUCTION CRITIQUE : Pour CHAQUE segment, vous recevrez :
- "Text to copy: [texte exact de l'histoire]"

Vous DEVEZ retourner un objet avec deux champs pour chaque segment :
1. "text" : Copiez le texte EXACT qui apparaît après "Text to copy:" - MOT POUR MOT avec chaque caractère, espace et ponctuation exactement comme fourni
2. "prompt" : Votre prompt d'image détaillé généré de 200-300 mots

IMPORTANT :
- Créez exactement UN prompt d'image pour chaque segment
- Copiez le texte EXACTEMENT après "Text to copy:" - ne résumez pas, ne paraphrasez pas, ne modifiez pas
- Utilisez le contexte complet de l'histoire pour la cohérence visuelle
- Concentrez-vous sur les détails visuels, composition, éclairage, émotions et atmosphère
- Exigences de style : ${style}
${environmentOnlyMode ? `- MODE ENVIRONNEMENT-UNIQUEMENT : Focus sur les lieux, objets et atmosphère. Évitez les visages de personnages.` : ''}
${charSystemInstruction}
${charReferenceBlock}
Sortie : Tableau JSON avec exactement le même nombre que segments d'entrée. Chaque élément DOIT avoir clés : 'text' (copie exacte après "Text to copy:"), 'prompt' (votre description de 200-300 mots)${schemaInstruction}.

${contextSection}`
  };
  
  return prompts[language as keyof typeof prompts] || prompts.english;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const payload: RequestBody = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) {
      console.error(`Validation error: ${validationError}`);
      return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { batch_segments, text_part, settings, use_character_descriptions, characters = {}, language, model, task_id, group_id } = payload;

    // Extract part number from text_part (if it's a number)
    const partNumber = parseInt(text_part, 10);
    const contextPartNumber = !isNaN(partNumber) && partNumber > 0 ? partNumber : 1;
    
    console.log(`Processing task ${task_id}: text_part="${text_part?.substring(0, 50)}...", using part_number: ${contextPartNumber}`);
    
    // Fetch full story context from image_prompt_context table
    const fullContext = await fetchFullContext(group_id, contextPartNumber);

    // Fetch task to get batch number
    const { data: taskData } = await supabase
      .from('image_prompt_tasks')
      .select('batch_number, user_id')
      .eq('id', task_id)
      .single();

    // Fetch previous batch prompts for continuity.
    // Limit to the 5 most-recent completed batches: getSystemPrompts only ever uses
    // previousPrompts.slice(-5), so fetching everything is wasteful and — for long
    // stories — transfers enough data to push generate-image-prompts past the 140s
    // window that process-image-batch waits before sending 202, causing Deno to kill
    // the in-flight connection and produce "Http: connection closed before message completed".
    let previousPrompts: string[] = [];
    const { data: completedTasks } = await supabase
      .from('image_prompt_tasks')
      .select('batch_output')
      .eq('group_id', group_id)
      .eq('status', 'completed')
      .lt('batch_number', taskData?.batch_number || 0)
      .order('batch_number', { ascending: false })
      .limit(5);

    if (completedTasks) {
      // Reverse so prompts are in oldest→newest order for slice(-5) consistency
      const orderedTasks = [...completedTasks].reverse();
      for (const ct of orderedTasks) {
        const extractedPrompts = extractPromptsFromBatchOutput(ct.batch_output);
        previousPrompts.push(...extractedPrompts);
      }
      console.log(`Loaded ${previousPrompts.length} previous prompts for context`);
    }

    // Normalize all text inputs consistently
    const normalizedBatchSegments = batch_segments.map(segment => ({
      ...segment,
      text: normalizeText(segment.text)
    }));

    // Validate and set language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language || '') ? language : 'english';

    // Validate and set model
    const supportedModels = ['deepseek', 'sonnet', 'opus'];
    const validatedModel = supportedModels.includes(model || '') ? model : 'sonnet';

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    
    // Generate context-aware system prompt
    console.log(`Using context-aware system prompt ${fullContext ? 'with full context' : '(context not available)'}`);
    const styleForPrompts = fullContext?.style_description || settings.style;
    const systemPrompt = getSystemPrompts(
      validatedLanguage,
      styleForPrompts,
      fullContext?.character_descriptions || characters,
      fullContext?.environment_only_mode || false,
      fullContext?.full_story_text || '',
      previousPrompts
    );
    
    // Format user prompt - explicitly show which text to copy
    // Detect very long segments (>5000 chars suggests 600+ second frequency)
    const hasVeryLongSegments = normalizedBatchSegments.some(seg => seg.text.length > 5000);
    const segmentWarning = hasVeryLongSegments 
      ? `\n🔴 CRITICAL: These segments are VERY LONG (600+ seconds). Each segment may contain multiple scenes or narrative transitions. YOU MUST CREATE ONLY ONE PROMPT PER SEGMENT regardless of length. Choose the most visually striking moment or create ONE composite description.\n\n` 
      : '';
    
    let userPrompt = `Process these ${normalizedBatchSegments.length} segment(s). For EACH segment, copy the "text" field EXACTLY and generate ONE prompt:${segmentWarning}\n`;
    normalizedBatchSegments.forEach((seg, idx) => {
      userPrompt += `Segment ${idx + 1} (${seg.text.length} characters):\nText to copy: ${seg.text}\n\n`;
    });

    const config = createModelClient(validatedModel);
   
    const isAnthropic = validatedModel === 'sonnet' || validatedModel === 'opus';
    const apiOptions = {
      max_tokens: isAnthropic ? 16000 : 8000,
      temperature: isAnthropic ? 0.4 : 0.6,
    };
   
    let response = await callModelAPI(config, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], apiOptions, validatedModel);

    let jsonOutput = response.choices[0].message.content.trim();
   
    console.log(`Raw ${validatedModel} response (first 500 chars):`, jsonOutput.substring(0, 500));

    let results: PromptResult[];
    let retryAttempt = 0;
    const maxRetries = 2;

    while (retryAttempt <= maxRetries) {
      try {
        results = cleanAndParseJSON(jsonOutput);
       
        if (!Array.isArray(results) || results.length === 0) {
          throw new Error('Invalid response: Results array is empty or not an array');
        }

        // CRITICAL: Validate that the number of results matches the number of input segments
        if (results.length !== normalizedBatchSegments.length) {
          console.error(`ERROR: Segment count mismatch! Expected ${normalizedBatchSegments.length} results, but got ${results.length}`);
          console.error(`Input segments: ${normalizedBatchSegments.length}`);
          console.error(`Output results: ${results.length}`);
          
          // If we got too many results, handle with retry or fallback
          if (results.length > normalizedBatchSegments.length) {
            if (retryAttempt < maxRetries) {
              // Try asking AI to combine
              retryAttempt++;
              console.log(`Retry attempt ${retryAttempt}: Asking AI to merge ${results.length} prompts into ${normalizedBatchSegments.length}`);
              
              const correctivePrompt = `STOP! You created ${results.length} separate prompts for ${normalizedBatchSegments.length} segment(s).

This is WRONG. Each segment = ONE prompt, regardless of how many scenes it contains.

You MUST merge your ${results.length} prompts into ${normalizedBatchSegments.length} combined prompt(s).

${normalizedBatchSegments.length === 1 ? 'Take ALL your prompts and combine them into ONE SINGLE 200-300 word prompt that captures the entire narrative flow or focuses on the most visually striking moment.' : `Map each of the ${normalizedBatchSegments.length} segments to exactly ONE prompt.`}

Return EXACTLY ${normalizedBatchSegments.length} result(s) with "text" (original segment text) and "prompt" (combined description).`;

              response = await callModelAPI(config, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
                { role: 'assistant', content: jsonOutput },
                { role: 'user', content: correctivePrompt }
              ], apiOptions, validatedModel);

              jsonOutput = response.choices[0].message.content.trim();
              console.log(`Retry ${retryAttempt} response (first 500 chars):`, jsonOutput.substring(0, 500));
              
              totalInputTokens += response.usage?.prompt_tokens || estimateTokens(correctivePrompt);
              totalOutputTokens += response.usage?.completion_tokens || estimateTokens(jsonOutput);
              continue; // Try parsing again
            } else {
              // Exhausted retries - force merge as fallback
              console.warn(`⚠️ FALLBACK: Force-merging ${results.length} prompts into ${normalizedBatchSegments.length} after ${maxRetries} failed retries`);
              
              // Combine all prompts into one for single-segment case
              if (normalizedBatchSegments.length === 1) {
                const combinedPrompt = results.map(r => r.prompt).join(' ');
                const fullText = normalizedBatchSegments[0].text;
                // Merge characters_mentioned from all parsed results
                const allMentioned = results.flatMap(r => Array.isArray(r.characters_mentioned) ? r.characters_mentioned : []);
                const uniqueMentioned = [...new Set(allMentioned)];
                results = [{
                  text: fullText,
                  original_text: fullText,
                  structured_text: fullText,
                  prompt: combinedPrompt.substring(0, 500), // Limit to reasonable length
                  characters_mentioned: uniqueMentioned.length > 0 ? uniqueMentioned : undefined,
                }];
                console.log(`Forced merge complete: 1 result with ${combinedPrompt.length} char prompt`);
                break; // Exit retry loop with merged result
              } else {
                // Multiple segments: take first N results
                console.warn(`Taking first ${normalizedBatchSegments.length} of ${results.length} results`);
                results = results.slice(0, normalizedBatchSegments.length);
                break;
              }
            }
          }
          
          throw new Error(`AI returned wrong number of prompts: expected ${normalizedBatchSegments.length}, got ${results.length}. Each segment must produce exactly ONE prompt.`);
        }

        // Validate required fields (text and prompt)
        for (const result of results) {
          if (!result.text || !result.prompt) {
            throw new Error('Invalid result: Missing required fields (text, prompt)');
          }
        }
        
        // Success - break out of retry loop
        break;
        
      } catch (error: any) {
        if (retryAttempt >= maxRetries || !error.message.includes('wrong number of prompts')) {
          console.error(`Error parsing ${validatedModel} response: ${error.message}`);
          console.error(`Full response that failed to parse:`, jsonOutput);
          await logError(`Error parsing ${validatedModel} response`, error);
          throw new Error(`Failed to parse ${validatedModel} response: ${error.message}`);
        }
        // If it's a count mismatch and we have retries left, the while loop will continue
      }
    }

    console.log(`Successfully generated ${results.length} prompts`);
    
    // Prepend style to each prompt (matching Python lines 1527-1530: item['prompt'] = style + ". " + item['prompt'])
    if (styleForPrompts) {
      console.log(`Prepending style to ${results.length} prompts`);
      results = results.map(result => ({
        ...result,
        prompt: styleForPrompts + '. ' + result.prompt
      }));
    }

    // Selectively append only mentioned character descriptions to each prompt
    // Mirrors Python logic: 3 cases:
    // 1. Characters matched for this segment → append only matched
    // 2. No match + custom_chars_in_story=false → append ALL characters (fallback)
    // 3. No match + custom_chars_in_story=true → append nothing (just no-text warning)
    const allChars: Record<string, string> = fullContext?.character_descriptions || characters || {};
    const customCharsInStory: boolean = fullContext?.custom_chars_in_story ?? true; // default true = names are trusted
    if (use_character_descriptions && Object.keys(allChars).length > 0) {
      console.log(`Selectively appending character descriptions to ${results.length} prompts (customCharsInStory=${customCharsInStory})`);
      results = results.map(result => {
        const mentioned = result.characters_mentioned;
        const filtered = filterCharacterDescriptions(allChars, mentioned);
        const hasMatched = Object.keys(filtered).length > 0;
        
        let charBlock: string;
        if (hasMatched) {
          // Case 1: Specific characters matched for this segment
          charBlock = formatCharacterDescriptions(filtered);
        } else if (!customCharsInStory) {
          // Case 2: Custom characters were provided but NONE of their names
          // appear in the story text → append ALL characters as fallback
          // so they are never silently dropped (matches Python behavior)
          charBlock = formatCharacterDescriptions(allChars);
        } else {
          // Case 3: Names exist in story but this segment doesn't feature them
          charBlock = formatCharacterDescriptions(null);
        }
        
        const { characters_mentioned, ...rest } = result;
        return {
          ...rest,
          prompt: rest.prompt + charBlock
        };
      });
    } else {
      // No characters — still append the no-text warning
      const noCharBlock = formatCharacterDescriptions(null);
      results = results.map(result => {
        const { characters_mentioned, ...rest } = result;
        return {
          ...rest,
          prompt: rest.prompt + noCharBlock
        };
      });
    }

    totalInputTokens += response.usage?.prompt_tokens || estimateTokens(systemPrompt + userPrompt);
    totalOutputTokens += response.usage?.completion_tokens || estimateTokens(jsonOutput);

    const userIdForBilling: string = (taskData?.user_id as string | undefined) ?? (auth.userId || '');
    const isLegacy = await getIsLegacyPlan(userIdForBilling);
    const tokenMultiplier = llmMultiplier(isLegacy, validatedModel);
    const adjustedInputTokens = Math.round(totalInputTokens * tokenMultiplier);
    const adjustedOutputTokens = Math.round(totalOutputTokens * tokenMultiplier);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    return new Response(
      JSON.stringify({
        results,
        input_tokens: adjustedInputTokens,
        output_tokens: adjustedOutputTokens,
        language: validatedLanguage,
        model: validatedModel
      }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    console.error(`Error in generate-image-prompts: ${error.message}`);
    await logError('Error in generate-image-prompts', error);

    let status = 500;
    let errorMessage = error.message || 'Internal server error';

    if (error.message.includes('rate limit') || error.message.includes('429')) {
      status = 429;
      errorMessage = 'Rate limit exceeded. Please try again later.';
    } else if (error.message.includes('invalid') || error.message.includes('missing')) {
      status = 400;
    } else if ([429, 500, 502, 503, 504, 520].some(code => error.message.includes(`HTTP ${code}`)) && (error.message.includes('DeepSeek API error') || error.message.includes('Anthropic API error'))) {
      status = parseInt(error.message.match(/HTTP (\d+)/)?.[1] || '500', 10);
      errorMessage = `API error: ${error.message}`;
    }

    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: responseHeaders }
    );
  }
});



