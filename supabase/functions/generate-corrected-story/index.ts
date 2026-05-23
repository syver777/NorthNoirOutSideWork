import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { OpenAI } from 'npm:openai@4';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, logError, TOKEN_PER_WORD, checkTokenAvailability, verifyAuth } from '../_shared/utils.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';
import { searchTopicContext, TAVILY_SEARCH_TOKEN_COST } from '../_shared/tavily.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = Deno.env.get('SECRET_KEY') ?? '';

// Model configurations
const MODEL_CONFIGS = {
  deepseek: {
    maxWordsPerBatch: 1400,
    apiKey: Deno.env.get('DEEPSEEK_API_KEY'),
    baseURL: 'https://api.deepseek.com',
    tokenMultiplier: 1.0
  },
  sonnet: {
    maxWordsPerBatch: 3000,
    apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 11.0
  },
  opus: {
    maxWordsPerBatch: 3000,
    apiKey: Deno.env.get('ANTHROPIC_API_KEY'),
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 19.0
  }
};

interface Chapter {
  number: number;
  title: string;
  part: string;
  word_count: number;
  summary: string;
}

interface StoryTask {
  id: string;
  user_id: string;
  group_id: string;
  batch: Chapter[];
  previous_content: string;
  total_word_count: number;
  batch_number: number;
  progress: number;
  status: string;
  story_title: string;
  feedback: string;
  language: string;
  model: string;
  pauses: boolean;
}

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]?.tokenMultiplier || 1.0;
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

// Call model API with streaming support
async function callModelAPI(client: any, messages: any[], options: any, model: string) {
  if (model === 'deepseek') {
    const stream = await client.chat.completions.create({
      ...options,
      messages: messages,
      stream: true, // Enable streaming for DeepSeek
    });
    
    let content = "";
    for await (const chunk of stream) {
      if (chunk.choices[0]?.delta?.content) {
        content += chunk.choices[0].delta.content;
      }
    }
    
    // Return in OpenAI-like format with estimated usage
    return {
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: Math.ceil(messages.map(m => m.content).join('').split(/\s+/).length * TOKEN_PER_WORD),
        completion_tokens: Math.ceil(content.split(/\s+/).length * TOKEN_PER_WORD)
      }
    };
  } else {
    // Enhanced streaming for Claude models with proper buffer handling
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': client.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
        max_tokens: options.max_tokens || 8000,
        temperature: options.temperature || 0.7,
        system: messages[0].content,
        messages: [{ role: 'user', content: messages[1].content }],
        stream: true // Enable streaming for Claude
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body reader available');
    }
    
    let content = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const decoder = new TextDecoder();
    let buffer = ''; // Buffer for incomplete SSE lines across chunks
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Append decoded chunk to buffer (handles multi-byte chars across chunks)
        buffer += decoder.decode(value, { stream: true });
        
        // Split on newlines but keep the last potentially incomplete line in the buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Last element may be incomplete, keep in buffer
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6);
            if (data === '[DONE]') continue;
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta') {
                content += parsed.delta.text || '';
              } else if (parsed.type === 'message_start') {
                inputTokens = parsed.message.usage?.input_tokens || 0;
              } else if (parsed.type === 'message_delta') {
                outputTokens = parsed.usage?.output_tokens || 0;
              }
            } catch (e) {
              // Log dropped data for debugging
              console.warn(`Failed to parse SSE data (${data.length} chars): ${data.substring(0, 100)}...`);
            }
          }
        }
      }
      
      // Process any remaining data in the buffer
      if (buffer.trim().startsWith('data: ')) {
        const data = buffer.trim().slice(6);
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta') {
              content += parsed.delta.text || '';
            } else if (parsed.type === 'message_delta') {
              outputTokens = parsed.usage?.output_tokens || 0;
            }
          } catch (e) {
            console.warn(`Failed to parse final SSE buffer (${data.length} chars): ${data.substring(0, 100)}...`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    
    // Convert to OpenAI-like format
    return {
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: inputTokens || Math.ceil(messages.map(m => m.content).join('').split(/\s+/).length * TOKEN_PER_WORD),
        completion_tokens: outputTokens || Math.ceil(content.split(/\s+/).length * TOKEN_PER_WORD)
      }
    };
  }
}

function getPausePromptInstructions(pauses: boolean): string {
  if (!pauses) return '';

  return `

TTS PAUSE INSTRUCTIONS:
This story is being written for text-to-speech narration. Insert pause markers at natural storytelling moments to enhance the listening experience.
These are SSML break tags that the TTS engine will interpret as silence.

Pause formats to use:
- Short pause: <break time="900ms" />  (after dramatic sentences, between tense moments, after key words)
- Medium pause: <break time="1500ms" />  (between paragraphs, at scene transitions, after reveals)
- Long pause: <break time="2500ms" />  (between chapters, at major scene changes, before/after climactic moments)
- Extra long pause: <break time="3500ms" />  (between major story sections, before the climax)

Pause placement guidelines:
- Place pauses where a skilled narrator would naturally pause for dramatic effect
- Use short pauses within paragraphs when it fits the story
- Use medium pauses between paragraphs and at minor scene shifts
- Use long pauses at chapter transitions and major dramatic beats
- Use extra long pauses only at major story divisions
- Aim for 3-4 pauses per paragraph - use them at impactful moments
- Medium, long, and extra long pauses should be placed on their own line between paragraphs
- Short pauses can be placed inline within the text after impactful words or phrases
- The pause markers are part of the final text and MUST be preserved exactly as shown above
`;
}

function getSystemPrompts(language: string, storyTitle: string, batchWordCount: number, totalWordCount: number, isRetry: boolean = false, pauses: boolean = false, youtubeTranscript?: string | null, contentType: string = 'story', searchContext?: string) {
  const baseWordCount = isRetry ? Math.floor(batchWordCount * 0.9) : batchWordCount;
  
  const prompts = {
    english: isRetry ? 
      `CRITICAL INSTRUCTION: Write EXACTLY ${baseWordCount} words. NO MORE. NO LESS.

You are a word-counting machine creating a corrected version of "${storyTitle}". Your ONLY job is to write exactly ${baseWordCount} words of corrected story content.

ABSOLUTE LIMITS:
- MAXIMUM WORDS: ${baseWordCount}
- STOP at word ${baseWordCount}
- DO NOT exceed this limit under ANY circumstances

Write corrected content for the given chapters based on the outline and feedback:
- Count every single word as you write
- Stop immediately when you reach word ${baseWordCount}
- Maintain continuity with previous content
- Use consistent style and voice
- Include natural transitions between chapters
- Incorporate vivid descriptions and engaging narrative
- Write from a narrative perspective without dialogue
- Include chapter headings in format **Chapter X: Chapter Title**

WORD COUNT ENFORCEMENT: You must count words continuously and stop at exactly ${baseWordCount} words. This is non-negotiable.

IMPORTANT: Do not include any word count reminders, targets, or instructions in your response. Start directly with the chapter heading and story content. Your response should contain ONLY the story text with chapter headings - no meta-commentary about word counts.` :
      `You are a creative writer crafting a corrected version of a Story/Novel titled "${storyTitle}". Write the specified chapters or parts based on the outline, strictly adhering to the provided feedback. Ensure:
- The tone and atmosphere align with the feedback and outline (e.g., documentary-style, suspenseful, eerie).
- Key themes from the feedback and outline are preserved (e.g., patriotism, survival, realism).
- Characters are consistent in behavior and development as per the feedback.
- Critical plot details and setting specifics from the outline are included.
- Narrative elements (e.g., action, tension, mystery) are balanced as described in the feedback.
- Aim for approximately the target word count for each chapter or part, totaling at least ${batchWordCount} words for this batch.
- The total word count across all chapters should contribute to at least ${totalWordCount} words for the full story.
- Maintain perfect continuity with previous content for a cohesive narrative.
- Use consistent style, vivid descriptions, and minimal dialogue as per feedback.
- Include headings: **Chapter X: Chapter Title** or **Chapter X: Chapter Title (Part Y)**, matching the outline exactly.
- Keep context under 48,000 words (~64,000 tokens).
Provide only the story text with specified headings, no additional commentary.`,

    german: isRetry ?
      `KRITISCHE ANWEISUNG: Schreiben Sie GENAU ${baseWordCount} Wörter. NICHT MEHR. NICHT WENIGER.

Sie sind eine Wortzählmaschine, die eine korrigierte Version von "${storyTitle}" erstellt. Ihr EINZIGER Job ist es, genau ${baseWordCount} Wörter korrigierter Geschichteninhalte zu schreiben.

ABSOLUTE GRENZEN:
- MAXIMUM WÖRTER: ${baseWordCount}
- STOPPEN bei Wort ${baseWordCount}
- Überschreiten Sie dieses Limit UNTER KEINEN UMSTÄNDEN

Schreiben Sie korrigierten Inhalt für die gegebenen Kapitel basierend auf der Gliederung und dem Feedback:
- Zählen Sie jedes einzelne Wort beim Schreiben
- Stoppen Sie sofort, wenn Sie Wort ${baseWordCount} erreichen
- Bewahren Sie Kontinuität mit vorherigem Inhalt
- Verwenden Sie konsistenten Stil und Stimme
- Fügen Sie natürliche Übergänge zwischen Kapiteln ein
- Integrieren Sie lebendige Beschreibungen und fesselnde Erzählung
- Schreiben Sie aus einer narrativen Perspektive ohne Dialoge
- Fügen Sie Kapitelüberschriften im Format **Kapitel X: Kapiteltitel** ein

WORTZAHL-DURCHSETZUNG: Sie müssen kontinuierlich Wörter zählen und bei genau ${baseWordCount} Wörtern stoppen. Dies ist nicht verhandelbar.

WICHTIG: Fügen Sie keine Wortzahl-Erinnerungen, Ziele oder Anweisungen in Ihre Antwort ein. Beginnen Sie direkt mit der Kapitelüberschrift und dem Geschichteninhalt. Ihre Antwort sollte NUR den Geschichtentext mit Kapitelüberschriften enthalten - keine Meta-Kommentare über Wortzahlen.` :
      `Sie sind ein kreativer Schriftsteller, der eine korrigierte Version einer Geschichte/Romans mit dem Titel "${storyTitle}" verfasst. Schreiben Sie die angegebenen Kapitel oder Teile basierend auf der Gliederung und halten Sie sich strikt an das bereitgestellte Feedback. Stellen Sie sicher:
- Der Ton und die Atmosphäre stimmen mit dem Feedback und der Gliederung überein (z.B. dokumentarischer Stil, spannend, unheimlich).
- Wichtige Themen aus dem Feedback und der Gliederung werden bewahrt (z.B. Patriotismus, Überleben, Realismus).
- Charaktere sind konsistent im Verhalten und in der Entwicklung gemäß dem Feedback.
- Kritische Handlungsdetails und Umgebungsspezifika aus der Gliederung sind enthalten.
- Narrative Elemente (z.B. Action, Spannung, Mysterium) sind ausgewogen wie im Feedback beschrieben.
- Streben Sie etwa die Zielwortzahl für jedes Kapitel oder Teil an, insgesamt mindestens ${batchWordCount} Wörter für diesen Batch.
- Die Gesamtwortzahl über alle Kapitel sollte zu mindestens ${totalWordCount} Wörtern für die ganze Geschichte beitragen.
- Bewahren Sie perfekte Kontinuität mit vorherigem Inhalt für eine kohärente Erzählung.
- Verwenden Sie konsistenten Stil, lebendige Beschreibungen und minimale Dialoge gemäß Feedback.
- Fügen Sie Überschriften ein: **Kapitel X: Kapiteltitel** oder **Kapitel X: Kapiteltitel (Teil Y)**, die genau der Gliederung entsprechen.
- Halten Sie den Kontext unter 48.000 Wörtern (~64.000 Tokens).
Geben Sie nur den Geschichtentext mit angegebenen Überschriften an, keine zusätzlichen Kommentare.`,

    spanish: isRetry ?
      `INSTRUCCIÓN CRÍTICA: Escribir EXACTAMENTE ${baseWordCount} palabras. NI MÁS. NI MENOS.

Eres una máquina contadora de palabras creando una versión corregida de "${storyTitle}". Tu ÚNICO trabajo es escribir exactamente ${baseWordCount} palabras de contenido de historia corregida.

LÍMITES ABSOLUTOS:
- MÁXIMO PALABRAS: ${baseWordCount}
- DETENTE en la palabra ${baseWordCount}
- NO excedas este límite bajo NINGUNA CIRCUNSTANCIA

Escribe contenido corregido para los capítulos dados basándote en el esquema y feedback:
- Cuenta cada palabra individual mientras escribes
- Detente inmediatamente cuando alcances la palabra ${baseWordCount}
- Mantén continuidad con el contenido previo
- Usa estilo y voz consistentes
- Incluye transiciones naturales entre capítulos
- Incorpora descripciones vívidas y narrativa atractiva
- Escribe desde una perspectiva narrativa sin diálogos
- Incluye encabezados de capítulos en formato **Capítulo X: Título del Capítulo**

APLICACIÓN DE RECUENTO DE PALABRAS: Debes contar palabras continuamente y detenerte en exactamente ${baseWordCount} palabras. Esto no es negociable.

IMPORTANTE: No incluyas ningún recordatorio de recuento de palabras, objetivos o instrucciones en tu respuesta. Comienza directamente con el encabezado del capítulo y el contenido de la historia. Tu respuesta debe contener SOLO el texto de la historia con encabezados de capítulos - sin meta-comentarios sobre recuentos de palabras.` :
      `Eres un escritor creativo creando una versión corregida de una Historia/Novela titulada "${storyTitle}". Escribe los capítulos o partes especificados basándote en el esquema, adhiriéndote estrictamente al feedback proporcionado. Asegúrate de:
- El tono y atmósfera se alineen con el feedback y esquema (ej. estilo documental, suspenso, inquietante).
- Los temas clave del feedback y esquema se preserven (ej. patriotismo, supervivencia, realismo).
- Los personajes sean consistentes en comportamiento y desarrollo según el feedback.
- Los detalles críticos de la trama y especificidades del escenario del esquema estén incluidos.
- Los elementos narrativos (ej. acción, tensión, misterio) estén equilibrados como se describe en el feedback.
- Apuntar aproximadamente al recuento de palabras objetivo para cada capítulo o parte, totalizando al menos ${batchWordCount} palabras para este lote.
- El recuento total de palabras en todos los capítulos debe contribuir a al menos ${totalWordCount} palabras para toda la historia.
- Mantener perfecta continuidad con el contenido previo para una narrativa cohesiva.
- Usar estilo consistente, descripciones vívidas y diálogo mínimo según el feedback.
- Incluir encabezados: **Capítulo X: Título del Capítulo** o **Capítulo X: Título del Capítulo (Parte Y)**, coincidiendo exactamente con el esquema.
- Mantener el contexto bajo 48,000 palabras (~64,000 tokens).
Proporcionar solo el texto de la historia con encabezados especificados, sin comentarios adicionales.`,

    french: isRetry ?
      `INSTRUCTION CRITIQUE : Écrire EXACTEMENT ${baseWordCount} mots. NI PLUS. NI MOINS.

Vous êtes une machine à compter les mots créant une version corrigée de "${storyTitle}". Votre SEUL travail est d'écrire exactement ${baseWordCount} mots de contenu d'histoire corrigée.

LIMITES ABSOLUES :
- MAXIMUM MOTS : ${baseWordCount}
- ARRÊTEZ au mot ${baseWordCount}
- NE dépassez PAS cette limite sous AUCUNE CIRCONSTANCE

Écrivez du contenu corrigé pour les chapitres donnés basé sur le plan et le feedback :
- Comptez chaque mot individuel en écrivant
- Arrêtez immédiatement quand vous atteignez le mot ${baseWordCount}
- Maintenez la continuité avec le contenu précédent
- Utilisez un style et une voix cohérents
- Incluez des transitions naturelles entre les chapitres
- Incorporez des descriptions vivantes et une narration engageante
- Écrivez d'une perspective narrative sans dialogues
- Incluez des en-têtes de chapitres au format **Chapitre X : Titre du Chapitre**

APPLICATION DU NOMBRE DE MOTS : Vous devez compter les mots continuellement et vous arrêter à exactement ${baseWordCount} mots. Ceci n'est pas négociable.

IMPORTANT : N'incluez aucun rappel de nombre de mots, objectifs ou instructions dans votre réponse. Commencez directement avec l'en-tête du chapitre et le contenu de l'histoire. Votre réponse doit contenir SEULEMENT le texte de l'histoire avec les en-têtes de chapitres - aucun méta-commentaire sur les nombres de mots.` :
      `Vous êtes un écrivain créatif rédigeant une version corrigée d'une Histoire/Roman intitulée "${storyTitle}". Écrivez les chapitres ou parties spécifiés basés sur le plan, en adhérant strictement au feedback fourni. Assurez-vous que :
- Le ton et l'atmosphère s'alignent avec le feedback et le plan (par ex. style documentaire, suspense, inquiétant).
- Les thèmes clés du feedback et du plan sont préservés (par ex. patriotisme, survie, réalisme).
- Les personnages sont cohérents dans leur comportement et développement selon le feedback.
- Les détails critiques de l'intrigue et les spécificités du cadre du plan sont inclus.
- Les éléments narratifs (par ex. action, tension, mystère) sont équilibrés comme décrit dans le feedback.
- Viser approximativement le nombre de mots cible pour chaque chapitre ou partie, totalisant au moins ${batchWordCount} mots pour ce lot.
- Le nombre total de mots à travers tous les chapitres devrait contribuer à au moins ${totalWordCount} mots pour l'histoire complète.
- Maintenir une continuité parfaite avec le contenu précédent pour un récit cohérent.
- Utiliser un style cohérent, des descriptions vivantes et un dialogue minimal selon le feedback.
- Inclure des en-têtes : **Chapitre X : Titre du Chapitre** ou **Chapitre X : Titre du Chapitre (Partie Y)**, correspondant exactement au plan.
- Garder le contexte sous 48 000 mots (~64 000 tokens).
Fournir seulement le texte de l'histoire avec les en-têtes spécifiés, aucun commentaire supplémentaire.`
  };

  const pauseInstructions = getPausePromptInstructions(pauses);
  const selectedPrompt = prompts[language as keyof typeof prompts] || prompts.english;
  return selectedPrompt + buildContentTypeWritingInstructions(contentType) + pauseInstructions + buildSearchContext(searchContext) + buildTranscriptContext(youtubeTranscript);
}

// Anti-hallucination rules shared across all non-story content types
const FACTUAL_ACCURACY_RULES = `\n\nFACTUAL ACCURACY RULES (CRITICAL):\n- Use ONLY data from these verified sources: (1) SOURCE TRANSCRIPT if provided, (2) WEB RESEARCH DATA if provided, (3) well-established common knowledge\n- When source material provides specific numbers, statistics, names, or data points — reproduce them precisely\n- For any specific numbers, statistics, costs, or claims NOT directly from the provided sources, you MUST use hedging language: "approximately", "estimated at", "reportedly", "around", "roughly", "believed to be"\n- NEVER invent specific statistics, dollar amounts, percentages, or dates — it is better to be vague than precisely wrong\n- If you are unsure about a fact, omit it or frame it with uncertainty rather than stating it as definitive`;

// Build content-type-specific writing instructions to append to corrected batch writing prompts
function buildContentTypeWritingInstructions(contentType: string): string {
  if (contentType === 'story') return '';
  
  const instructions: Record<string, string> = {
    documentary: `\n\nCONTENT TYPE: DOCUMENTARY\nYou are writing a corrected DOCUMENTARY script, not fiction. Key requirements:\n- Write factual narration about real events, people, and phenomena with an authoritative documentary tone\n- Focus on compelling narrative storytelling — build interest and suspense through pacing, tension, and structure rather than data overload\n- Reference specific dates, locations, names, and documented facts from the provided source material accurately\n- When source material provides numbers or stats, reproduce them precisely rather than generalizing\n- Name specific companies, technologies, locations, and people rather than using vague references\n- Use evidence-based claims and maintain historical/scientific accuracy\n- Write entirely from a third-person narrator's perspective — ONE narrator describes everything\n- When referencing what people said, use indirect/reported speech (e.g., "According to Smith, the situation was dire")\n- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice\n- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,

    informational: `\n\nCONTENT TYPE: INFORMATIONAL/EDUCATIONAL\nYou are writing a corrected INFORMATIONAL/EDUCATIONAL script, not fiction. Key requirements:\n- Explain concepts, processes, and topics clearly and engagingly\n- Prioritize factual density: include specific numbers, statistics, measurements, and data points from the provided source material throughout\n- Use concrete examples, real-world analogies, and verifiable data to illustrate ideas\n- When source material provides numbers (costs, speeds, sizes, growth rates), include them precisely — these make the content credible\n- Name specific companies, technologies, products, researchers, and locations rather than generalizing\n- Build understanding progressively — don't assume excessive prior knowledge\n- Maintain an authoritative but accessible educational tone that makes complex data digestible\n- Write entirely from a third-person narrator's perspective — ONE narrator explains everything\n- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice\n- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,

    commentary: `\n\nCONTENT TYPE: COMMENTARY/ANALYSIS\nYou are writing a corrected COMMENTARY/ANALYSIS script, not fiction. Key requirements:\n- Present well-reasoned analysis and perspectives on the topic\n- Focus on argumentation, reasoning, and insight — data supports the argument but isn't required in every paragraph\n- Support key arguments with specific evidence from the provided source material\n- When source material provides data points, weave them into the argument to strengthen credibility\n- Name specific companies, people, technologies, and events rather than generalizing\n- Consider multiple viewpoints before drawing conclusions\n- Maintain a thoughtful, authoritative analytical tone\n- Write entirely from a third-person narrator's perspective — ONE narrator presents the analysis\n- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice\n- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,
  };
  
  return instructions[contentType] || '';
}

function buildTranscriptContext(youtubeTranscript?: string | null): string {
  if (!youtubeTranscript) return '';
  return `\n\n=== SOURCE TRANSCRIPT (FACTUAL REFERENCE) ===\nThe following is a raw transcript from a source video. You MUST incorporate specific facts, numbers, names, companies, technical details, and claims from this transcript into the story. Do NOT invent or generalize — use the actual data points provided below. Weave these facts naturally into the narrative.\n\n${youtubeTranscript}\n\n=== END SOURCE TRANSCRIPT ===`;
}

function buildSearchContext(searchContext?: string): string {
  if (!searchContext) return '';
  return searchContext;
}

function validateInputs(data: any): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.chapters || !Array.isArray(data.chapters)) return 'Missing or invalid chapters';
  if (typeof data.previous_content !== 'string') return 'Missing or invalid previous_content';
  if (typeof data.total_word_count !== 'number' || data.total_word_count <= 0) return 'Invalid total_word_count';
  if (typeof data.group_id !== 'string' || !data.group_id.match(uuidRegex)) return 'Missing or invalid group_id';
  if (typeof data.user_id !== 'string' || !data.user_id.match(uuidRegex)) return 'Missing or invalid user_id';
  if (typeof data.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  if (typeof data.feedback !== 'string') return 'Missing or invalid feedback';
  if (typeof data.variant !== 'undefined' && (typeof data.variant !== 'number' || data.variant < 1)) return 'Invalid variant';
  return null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

async function triggerRetry(payload: any, retryAttempt: number = 1): Promise<void> {
  try {
    console.log(`Triggering retry attempt ${retryAttempt} for corrected batch ${payload.batch_number}`);
    
    // Add retry flag to payload
    const retryPayload = {
      ...payload,
      retry_attempt: retryAttempt,
      is_retry: true
    };
    
    // Call generate-corrected-story again asynchronously
    fetch(`${supabaseUrl}/functions/v1/generate-corrected-story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify(retryPayload),
    }).catch(error => {
      console.error(`Error triggering retry for corrected batch ${payload.batch_number}: ${error.message}`);
      logError(`Error triggering retry for corrected batch ${payload.batch_number}`, error);
    });
  } catch (error: any) {
    console.error(`Error in triggerRetry: ${error.message}`);
    await logError('Error in triggerRetry', error);
  }
}

async function writeCorrectedBatch(
  chapters: Chapter[],
  previousContent: string,
  feedback: string,
  totalWordCount: number,
  storyTitle: string,
  language: string = 'english',
  model: string = 'sonnet',
  isRetry: boolean = false,
  retryAttempt: number = 0,
  pauses: boolean = false,
  youtubeTranscript: string | null = null,
  contentType: string = 'story',
  searchContext?: string,
  userId?: string
): Promise<[string, number, number]> {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  let batchWordCount = chapters.reduce((sum, ch) => sum + ch.word_count, 0);
  
  if (batchWordCount > config.maxWordsPerBatch) {
    throw new Error(`Batch word count exceeds ${config.maxWordsPerBatch}: ${batchWordCount}`);
  }

  // Reduce word count for retries on Claude models
  if (isRetry && (model === 'sonnet' || model === 'opus')) {
    const reductionFactor = 0.85; // Reduce by 15% for retries
    batchWordCount = Math.floor(batchWordCount * reductionFactor);
    console.log(`Retry attempt: Reducing target to ${batchWordCount} words for ${model}`);
  }

  const systemPrompt = getSystemPrompts(language, storyTitle, batchWordCount, totalWordCount, isRetry, pauses, youtubeTranscript, contentType, searchContext);

  const chaptersOutline = chapters.map(c => ({
    number: c.number,
    title: c.title,
    part: c.part,
    summary: c.summary,
  }));

  const userPrompts = {
    english: `Write a corrected version of the following chapters or parts based on this outline:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nStrictly follow this feedback:\n${feedback}\n\nPrevious content (for continuity):\n${previousContent}`,
    german: `Schreiben Sie eine korrigierte Version der folgenden Kapitel oder Teile basierend auf dieser Gliederung:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nBfolgen Sie strikt dieses Feedback:\n${feedback}\n\nVorheriger Inhalt (für Kontinuität):\n${previousContent}`,
    spanish: `Escribe una versión corregida de los siguientes capítulos o partes basándote en este esquema:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nSigue estrictamente este feedback:\n${feedback}\n\nContenido previo (para continuidad):\n${previousContent}`,
    french: `Écrivez une version corrigée des chapitres ou parties suivants basée sur ce plan :\n${JSON.stringify(chaptersOutline, null, 2)}\n\nSuivez strictement ce feedback :\n${feedback}\n\nContenu précédent (pour la continuité) :\n${previousContent}`
  };

  const userPrompt = userPrompts[language as keyof typeof userPrompts] || userPrompts.english;

  const client = createModelClient(model);

  try {
    const maxTokens = model === 'deepseek' ? 8000 : 8000;
    let temperature = model === 'deepseek' ? 1.0 : 0.7;
    
    // Lower temperature for retries
    if (isRetry) {
      temperature = Math.max(0.2, temperature - 0.2);
    }

    const response = await callModelAPI(client, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], {
      model: model === 'deepseek' ? 'deepseek-chat' : model,
      max_tokens: maxTokens,
      temperature: temperature,
    }, model);

    let batchContent = response.choices[0].message.content || '';
    
    // Remove any word count headers from the beginning
    batchContent = batchContent.replace(/^#.*WORD COUNT.*\n+/gm, '').trim();

    // Validate SSML integrity - fix broken break tags from potential streaming issues
    batchContent = batchContent.replace(/<break\s+time(?:="?\d+ms"?)?\s*(?!\/)>/g, '');
    batchContent = batchContent.replace(/<break\s+time\s*$/gm, '');
    const brokenBreakTags = batchContent.match(/<break[^>]*(?<!\/)>/g);
    if (brokenBreakTags && brokenBreakTags.length > 0) {
      console.warn(`Found ${brokenBreakTags.length} malformed SSML break tags, cleaning up...`);
      batchContent = batchContent.replace(/<break[^>]*(?<!\/)>/g, '');
    }
    
    let inputTokens = response.usage?.prompt_tokens || Math.ceil(countWords(systemPrompt + userPrompt) * TOKEN_PER_WORD);
    let outputTokens = response.usage?.completion_tokens || Math.ceil(countWords(batchContent) * TOKEN_PER_WORD);

    // Apply token multiplier for cost normalization (legacy vs new plan)
    const isLegacy = await getIsLegacyPlan(userId ?? '');
    const tokenMultiplier = llmMultiplier(isLegacy, model);
    const adjustedInputTokens = Math.round(inputTokens * tokenMultiplier);
    const adjustedOutputTokens = Math.round(outputTokens * tokenMultiplier);

    // Enhanced heading validation - more flexible
    for (const chapter of chaptersOutline) {
      const possibleHeadings = [
        `**Chapter ${chapter.number}: ${chapter.title}**`,
        `**Chapter ${chapter.number}: **${chapter.title}**`,
        `Chapter ${chapter.number}: ${chapter.title}`,
        `**${chapter.title}**`,
        chapter.title
      ];
      
      const headingFound = possibleHeadings.some(heading => 
        batchContent.includes(heading)
      );
      
      if (!headingFound) {
        console.warn(`Warning: No matching heading found for corrected chapter ${chapter.number}. Expected variations not found.`);
      }
    }

    console.log(`Corrected batch written: ${chapters.length} chapters/parts, ${countWords(batchContent)} words, language: ${language}, model: ${model}.`);
    return [batchContent, adjustedInputTokens, adjustedOutputTokens];
  } catch (error: any) {
    if (error.response?.status === 429 || error.response?.status >= 500 || error.message.includes('overloaded')) {
      console.log(`Transient error: ${error.message}. Will be retried by process-corrected-story.`);
      throw error;
    }
    throw error;
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth check
  const auth = await verifyAuth(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let payload;
  try {
    payload = await req.json();
    if (!auth.isServiceRole && auth.userId) { payload.user_id = auth.userId; }
    console.log('Received payload:', JSON.stringify(payload, null, 2));
  } catch (error: any) {
    await logError('Invalid JSON payload', error);
    return new Response(
      JSON.stringify({ error: 'Invalid JSON payload', code: 400 }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed', code: 405 }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const validationError = validateInputs(payload);
    if (validationError) {
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { chapters, previous_content, total_word_count, group_id, user_id, batch_number, feedback, is_retry = false, retry_attempt = 0, variant = 1, youtube_transcript = null, content_type = 'story' } = payload;

    console.log(`Querying story_tasks with group_id: ${group_id}, user_id: ${user_id}, batch_number: ${batch_number}, is_corrected: true, version: 2, variant: ${variant}`);

    const { data: task, error: taskError } = await supabase
      .from('story_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', batch_number)
      .eq('is_corrected', true)
      .eq('version', 2)
      .eq('variant', variant)
      .single();

    if (taskError || !task) {
      console.error(`Task query error: ${taskError?.message || 'No task found'}`);
      console.log(`Queried parameters: group_id=${group_id}, user_id=${user_id}, batch_number=${batch_number}, is_corrected=true, version=2`);
      return new Response(
        JSON.stringify({ error: 'Task not found', code: 404 }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if task is already completed (by a retry or another process)
    if (task.status === 'completed' && task.previous_content) {
      console.log(`Corrected task ${task.id} is already completed, returning existing content`);
      return new Response(
        JSON.stringify({
          content: task.previous_content,
          input_tokens: task.input_tokens || 0,
          output_tokens: task.output_tokens || 0,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found task: id=${task.id}, batch=${JSON.stringify(task.batch)}, language=${task.language}, model=${task.model}`);

    const batchChapters = chapters.filter((ch: Chapter) =>
      task.batch.some((taskCh: Chapter) => taskCh.number === ch.number && taskCh.part === ch.part)
    );

    if (batchChapters.length === 0) {
      console.error(`No matching chapters for corrected task batch: ${JSON.stringify(task.batch)}`);
      return new Response(
        JSON.stringify({ error: 'No chapters match corrected task batch', code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const taskLanguage = task.language || 'english';
    const taskModel = task.model || 'sonnet';
    console.log(`Processing corrected batch ${batch_number} for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel}${is_retry ? ' (retry)' : ''}`);

    try {
      // Search for topic context for non-story content types
      const chapterTitles = batchChapters.map((ch: Chapter) => ch.title);
      const searchResult = await searchTopicContext(task.story_title, chapterTitles, content_type);
      if (searchResult.creditsUsed > 0) {
        console.log(`Tavily search used ${searchResult.creditsUsed} credits for corrected batch ${batch_number}`);
      }

      const [batchContent, rawInputTokens, rawOutputTokens] = await writeCorrectedBatch(
        batchChapters,
        previous_content,
        feedback,
        total_word_count,
        task.story_title,
        taskLanguage,
        taskModel,
        is_retry,
        retry_attempt,
        task.pauses || false,
        youtube_transcript,
        content_type,
        searchResult.context,
        user_id
      );

      // Add Tavily search cost to output tokens for billing
      const inputTokens = rawInputTokens;
      const outputTokens = rawOutputTokens + (searchResult.creditsUsed > 0 ? TAVILY_SEARCH_TOKEN_COST : 0);

      // Check if batch content exceeds target by more than 40% for Claude models and we haven't retried yet
      if (!is_retry && taskModel !== 'deepseek' && retry_attempt < 2) {
        const actualWords = countWords(batchContent);
        const targetWords = batchChapters.reduce((sum, ch) => sum + ch.word_count, 0);
        
        if (actualWords > targetWords * 1.4) {
          console.warn(`Warning: Corrected batch generated ${actualWords} words, target was ${targetWords}. Exceeds 40% threshold.`);
          console.log(`Triggering retry with stricter instructions...`);
          
          // Check if tokens can be added before updating
          const tokenCheck = await checkTokenAvailability(user_id, inputTokens, outputTokens);
          
          if (tokenCheck.canUseTokens) {
            // Update the task with current content first
            const { error: updateError } = await supabase
              .from('story_tasks')
              .update({
                progress: 100,
                status: 'completed',
                previous_content: batchContent,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);

            if (updateError) {
              console.error(`Failed to update corrected task ${task.id}: ${updateError.message}`);
            }
          } else {
            // Update without tokens to avoid constraint violation
            console.warn(`Skipping token update for corrected task ${task.id}: ${tokenCheck.reason}`);
            const { error: updateError } = await supabase
              .from('story_tasks')
              .update({
                progress: 100,
                status: 'completed',
                previous_content: batchContent,
                updated_at: new Date().toISOString(),
              })
              .eq('id', task.id);

            if (updateError) {
              console.error(`Failed to update corrected task ${task.id} without tokens: ${updateError.message}`);
            }
            
            // Log the token limit issue
            await logError(`Token limit exceeded for user ${user_id}`, new Error(tokenCheck.reason || 'Token limit exceeded'));
          }

          // Trigger retry asynchronously
          await triggerRetry(payload, retry_attempt + 1);

          // Still trigger next batch since we have content
          const nextBatchNumber = batch_number + 1;
          const { data: nextTask, error: nextTaskError } = await supabase
            .from('story_tasks')
            .select('id, batch_number, status, total_batches')
            .eq('group_id', group_id)
            .eq('user_id', user_id)
            .eq('batch_number', nextBatchNumber)
            .eq('is_corrected', true)
            .eq('version', 2)
            .eq('variant', 1)
            .eq('tab', tab)
            .single();

          if (!nextTaskError && nextTask && (nextTask.status === 'pending' || nextTask.status === 'error' || nextTask.status === 'queued')) {
            console.log(`Triggering next corrected batch ${nextBatchNumber} directly from generate-corrected-story`);
            
            await supabase
              .from('story_tasks')
              .update({ 
                status: 'running', 
                updated_at: new Date().toISOString() 
              })
              .eq('id', nextTask.id);
            
            fetch(`${supabaseUrl}/functions/v1/process-corrected-story`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
              },
              body: JSON.stringify({
                group_id: group_id,
                user_id: user_id,
                batch_number: nextBatchNumber,
                total_batches: nextTask.total_batches,
                tab: tab,
              }),
            }).catch(error => {
              console.error(`Error triggering next corrected batch ${nextBatchNumber} from generate-corrected-story: ${error.message}`);
            });
          }

          console.log(`Processed corrected batch ${batch_number} (100.00%) for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel} (retry triggered)`);

          return new Response(
            JSON.stringify({
              content: batchContent,
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              retry_triggered: true
            }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      // Check if tokens can be added before updating
      const tokenCheck = await checkTokenAvailability(user_id, inputTokens, outputTokens);
      
      if (tokenCheck.canUseTokens) {
        // Normal completion - update the task with tokens
        const { error: updateError } = await supabase
          .from('story_tasks')
          .update({
            progress: 100,
            status: 'completed',
            previous_content: batchContent,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        if (updateError) {
          console.error(`Failed to update corrected task ${task.id}: ${updateError.message}`);
        }
      } else {
        // Update without tokens to avoid constraint violation
        console.warn(`Skipping token update for corrected task ${task.id}: ${tokenCheck.reason}`);
        const { error: updateError } = await supabase
          .from('story_tasks')
          .update({
            progress: 100,
            status: 'completed',
            previous_content: batchContent,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task.id);

        if (updateError) {
          console.error(`Failed to update corrected task ${task.id} without tokens: ${updateError.message}`);
        }
        
        // Log the token limit issue
        await logError(`Token limit exceeded for user ${user_id}`, new Error(tokenCheck.reason || 'Token limit exceeded'));
      }

      // Check if there's a next batch and trigger it directly (only if not a retry)
      if (!is_retry) {
        const nextBatchNumber = batch_number + 1;
        const { data: nextTask, error: nextTaskError } = await supabase
          .from('story_tasks')
          .select('id, batch_number, status, total_batches')
          .eq('group_id', group_id)
          .eq('user_id', user_id)
          .eq('batch_number', nextBatchNumber)
          .eq('is_corrected', true)
          .eq('version', 2)
          .eq('variant', 1)
          .eq('tab', tab)
          .single();

        if (!nextTaskError && nextTask && (nextTask.status === 'pending' || nextTask.status === 'error' || nextTask.status === 'queued')) {
          console.log(`Triggering next corrected batch ${nextBatchNumber} directly from generate-corrected-story`);
          
          // Set to running first
          await supabase
            .from('story_tasks')
            .update({ 
              status: 'running', 
              updated_at: new Date().toISOString() 
            })
            .eq('id', nextTask.id);
          
          // Then trigger process-corrected-story for the next batch
          fetch(`${supabaseUrl}/functions/v1/process-corrected-story`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
            },
            body: JSON.stringify({
              group_id: group_id,
              user_id: user_id,
              batch_number: nextBatchNumber,
              total_batches: nextTask.total_batches,
              tab: tab,
            }),
          }).catch(error => {
            console.error(`Error triggering next corrected batch ${nextBatchNumber} from generate-corrected-story: ${error.message}`);
          });
          
        } else if (nextTask && nextTask.status === 'running') {
          console.log(`Next corrected batch ${nextBatchNumber} is already running`);
        }
      }

      console.log(`Processed corrected batch ${batch_number} (100.00%) for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel}${is_retry ? ' (retry)' : ''}`);

      return new Response(
        JSON.stringify({
          content: batchContent,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (error: any) {
      // If this is already a retry, don't retry again
      if (is_retry || retry_attempt >= 2) {
        throw error;
      }
      
      // For certain errors, trigger a retry
      if (error.message.includes('rate limit') || error.message.includes('overloaded') || error.response?.status >= 500) {
        console.log(`Triggering retry due to error: ${error.message}`);
        await triggerRetry(payload, retry_attempt + 1);
        
        // Return error but indicate retry was triggered
        return new Response(
          JSON.stringify({ 
            error: `Error occurred, retry triggered: ${error.message}`, 
            code: 500,
            retry_triggered: true
          }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      throw error;
    }
  } catch (error: any) {
    await logError('Error in generate-corrected-story', error);
    let status = 500;
    let errorMessage = error.message || 'Internal server error';
    if (error.message.includes('rate limit') || error.status === 429) {
      status = 429;
      errorMessage = 'Rate limit exceeded. Please try again later.';
    } else if (error.message.includes('invalid') || error.message.includes('missing')) {
      status = 400;
    }
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});



