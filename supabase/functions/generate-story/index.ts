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
  language: string;
  model: string;
  pauses: boolean;
}

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]?.tokenMultiplier || 1.0;
}

function calculateTokensUsed(inputTokens: number, outputTokens: number): number {
  return inputTokens * 0.25 + outputTokens;
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
        temperature: options.temperature || 0.5,
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

function getContextInstructions(previousContent: string): string {
  if (!previousContent) return "No previous content.";
  
  if (previousContent.includes("Batch Plan:")) {
    return "The content below is the STORY OUTLINE for reference only. Write ONLY the specific chapter(s) requested in the prompt. Do NOT write sequentially after the outline—write the exact chapters specified, which may be Chapter 1 (the beginning) or any other specific chapters.";
  } else {
    // Find the last chapter number
    const lastChapterMatch = previousContent.match(/\*\*Chapter (\d+):/g);
    if (lastChapterMatch) {
      const lastChapter = lastChapterMatch[lastChapterMatch.length - 1];
      const chapterNum = lastChapter.match(/\d+/)?.[0];
      return `The content below shows completed story content through ${lastChapter}. Write the NEXT sequential chapter (Chapter ${parseInt(chapterNum || '0') + 1}).`;
    }
    return "The content below shows previous story content. Write the next sequential chapter.";
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

function buildStyleContext(masterPrompt: any): string {
  if (!masterPrompt) return '';

  // Parse if it's a string
  let mp = masterPrompt;
  if (typeof mp === 'string') {
    try { mp = JSON.parse(mp); } catch { return ''; }
  }

  let context = '';

  if (mp.tonalGuidelines?.trim()) {
    context += `\nWRITING STYLE & TONE (follow these guidelines precisely):\n${mp.tonalGuidelines.trim()}\n`;
  }

  if (mp.narrativeStructure?.trim()) {
    context += `\nNARRATIVE STRUCTURE (follow this blueprint):\n${mp.narrativeStructure.trim()}\n`;
  }

  if (mp.consistencyNotes?.trim()) {
    context += `\nCONSISTENCY RULES:\n${mp.consistencyNotes.trim()}\n`;
  }

  // Include character details for voice/personality consistency
  if (mp.characters?.length > 0) {
    const charDetails = mp.characters
      .filter((c: any) => c.name?.trim())
      .map((c: any) => {
        let detail = `- ${c.name}`;
        if (c.personality?.trim()) detail += `: ${c.personality.trim()}`;
        if (c.appearance?.trim()) detail += ` Appearance: ${c.appearance.trim()}`;
        return detail;
      })
      .join('\n');
    if (charDetails) {
      context += `\nCHARACTER REFERENCE:\n${charDetails}\n`;
    }
  }

  return context;
}

// Anti-hallucination rules shared across all non-story content types
const FACTUAL_ACCURACY_RULES = `

FACTUAL ACCURACY RULES (CRITICAL):
- Use ONLY data from these verified sources: (1) SOURCE TRANSCRIPT if provided, (2) WEB RESEARCH DATA if provided, (3) well-established common knowledge
- When source material provides specific numbers, statistics, names, or data points — reproduce them precisely
- For any specific numbers, statistics, costs, or claims NOT directly from the provided sources, you MUST use hedging language: "approximately", "estimated at", "reportedly", "around", "roughly", "believed to be"
- NEVER invent specific statistics, dollar amounts, percentages, or dates — it is better to be vague than precisely wrong
- If you are unsure about a fact, omit it or frame it with uncertainty rather than stating it as definitive`;

// Build content-type-specific writing instructions to append to batch writing prompts
function buildContentTypeWritingInstructions(contentType: string): string {
  if (contentType === 'story') return '';
  
  const instructions: Record<string, string> = {
    documentary: `

CONTENT TYPE: DOCUMENTARY
You are writing a DOCUMENTARY script, not fiction. Key requirements:
- Write factual narration about real events, people, and phenomena with an authoritative documentary tone
- Focus on compelling narrative storytelling — build interest and suspense through pacing, tension, and structure rather than data overload
- Reference specific dates, locations, names, and documented facts from the provided source material accurately
- When source material provides numbers or stats, reproduce them precisely rather than generalizing
- Name specific companies, technologies, locations, and people rather than using vague references
- Use evidence-based claims and maintain historical/scientific accuracy
- Write entirely from a third-person narrator's perspective — ONE narrator describes everything
- When referencing what people said, use indirect/reported speech (e.g., "According to Smith, the situation was dire")
- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice
- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,

    informational: `

CONTENT TYPE: INFORMATIONAL/EDUCATIONAL
You are writing an INFORMATIONAL/EDUCATIONAL script, not fiction. Key requirements:
- Explain concepts, processes, and topics clearly and engagingly
- Prioritize factual density: include specific numbers, statistics, measurements, and data points from the provided source material throughout
- Use concrete examples, real-world analogies, and verifiable data to illustrate ideas
- When source material provides numbers (costs, speeds, sizes, growth rates), include them precisely — these make the content credible
- Name specific companies, technologies, products, researchers, and locations rather than generalizing
- Build understanding progressively — don't assume excessive prior knowledge
- Maintain an authoritative but accessible educational tone that makes complex data digestible
- Write entirely from a third-person narrator's perspective — ONE narrator explains everything
- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice
- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,

    commentary: `

CONTENT TYPE: COMMENTARY/ANALYSIS
You are writing a COMMENTARY/ANALYSIS script, not fiction. Key requirements:
- Present well-reasoned analysis and perspectives on the topic
- Focus on argumentation, reasoning, and insight — data supports the argument but isn't required in every paragraph
- Support key arguments with specific evidence from the provided source material
- When source material provides data points, weave them into the argument to strengthen credibility
- Name specific companies, people, technologies, and events rather than generalizing
- Consider multiple viewpoints before drawing conclusions
- Maintain a thoughtful, authoritative analytical tone
- Write entirely from a third-person narrator's perspective — ONE narrator presents the analysis
- NEVER include dialogue lines, screenplay format, or character speech — everything must be narrated by a single voice
- This content will be converted to text-to-speech with one narrator voice` + FACTUAL_ACCURACY_RULES,
  };
  
  return instructions[contentType] || '';
}

function getSystemPrompts(language: string, batchWordCount: number, totalWordCount: number, model: string, isRetry: boolean = false, pauses: boolean = false, masterPrompt?: any, youtubeTranscript?: string | null, contentType: string = 'story', searchContext?: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  const maxWordsPerBatch = config.maxWordsPerBatch;
  
  if (model === 'deepseek') {
    const prompts = {
      english: `You are a creative writer. You have ONE CRITICAL JOB: Write EXACTLY ${batchWordCount} words. Not ${batchWordCount + 1}, not ${batchWordCount - 1}. EXACTLY ${batchWordCount} words.

ABSOLUTE WORD COUNT LIMIT: ${batchWordCount} words. STOP WRITING THE MOMENT YOU REACH THIS NUMBER.

Write the content for the given chapters or chapter parts based on the outline, ensuring:
- Write EXACTLY ${batchWordCount} words total for this batch. This is non-negotiable.
- The total word count across all chapters should contribute to at least ${totalWordCount} words for the full story.
- Maintain perfect continuity with the previous content provided.
- Use a consistent style and voice throughout.
- Include natural transitions between chapters or parts.
- Incorporate vivid descriptions.
- Write the story entirely from a narrative perspective, focusing solely on descriptive storytelling.
- No written dialogue ever.
- Begin the first part of the story with a compelling hook related to the subject, designed to immediately intrigue and captivate the reader.
- Keep the total context under 48,000 words (~64,000 tokens).
- For each chapter or part, include a heading in the format **Chapter X: Chapter Title** or **Chapter X: Chapter Title (Part Y)**, where X is EXACTLY the chapter number provided in the outline (do NOT modify or renumber it), Chapter Title is the title from the outline, and Part Y is the part identifier if applicable. Use the exact number provided in the chapter data without any adjustments.

FINAL REMINDER: Your response must contain EXACTLY ${batchWordCount} words. Count as you write and STOP immediately at ${batchWordCount}. Quality over quantity - make every word count within the strict limit.

IMPORTANT: Do not include any word count reminders, targets, or instructions in your response. Start directly with the chapter heading and story content. Your response should contain ONLY the story text with chapter headings - no meta-commentary about word counts.

Provide only the story text for the chapters or parts in this batch, with the specified headings, and no additional commentary or content.`,

      german: `Sie sind ein kreativer Schriftsteller. Sie haben EINE KRITISCHE AUFGABE: Schreiben Sie GENAU ${batchWordCount} Wörter. Nicht ${batchWordCount + 1}, nicht ${batchWordCount - 1}. GENAU ${batchWordCount} Wörter.

ABSOLUTES WORTZAHLLIMIT: ${batchWordCount} Wörter. HÖREN SIE AUF ZU SCHREIBEN, SOBALD SIE DIESE ZAHL ERREICHEN.

Schreiben Sie den Inhalt für die gegebenen Kapitel oder Kapitelteile basierend auf der Gliederung und stellen Sie sicher:
- Schreiben Sie GENAU ${batchWordCount} Wörter insgesamt für diesen Batch. Dies ist nicht verhandelbar.
- Die Gesamtwortzahl über alle Kapitel sollte zu mindestens ${totalWordCount} Wörtern für die ganze Geschichte beitragen.
- Bewahren Sie perfekte Kontinuität mit dem bereitgestellten vorherigen Inhalt.
- Verwenden Sie einen konsistenten Stil und eine konsistente Stimme durchgehend.
- Fügen Sie natürliche Übergänge zwischen Kapiteln oder Teilen ein.
- Integrieren Sie lebendige Beschreibungen.
- Schreiben Sie die Geschichte vollständig aus einer narrativen Perspektive, konzentriert auf beschreibendes Erzählen.
- Niemals geschriebene Dialoge.
- Beginnen Sie den ersten Teil der Geschichte mit einem fesselnden Haken zum Thema.
- Für jedes Kapitel oder Teil fügen Sie eine Überschrift im Format **Kapitel X: Kapiteltitel** ein.

ABSCHLIESSENDE ERINNERUNG: Ihre Antwort muss GENAU ${batchWordCount} Wörter enthalten. Zählen Sie beim Schreiben und STOPPEN Sie sofort bei ${batchWordCount}.

WICHTIG: Fügen Sie keine Wortzahl-Erinnerungen, Ziele oder Anweisungen in Ihre Antwort ein. Beginnen Sie direkt mit der Kapitelüberschrift und dem Geschichteninhalt. Ihre Antwort sollte NUR den Geschichtentext mit Kapitelüberschriften enthalten - keine Meta-Kommentare über Wortzahlen.

Geben Sie nur den Geschichtentext für die Kapitel oder Teile in diesem Batch mit den angegebenen Überschriften und keine zusätzlichen Kommentare oder Inhalte.`,

      spanish: `Eres un escritor creativo. Tienes UN TRABAJO CRÍTICO: Escribir EXACTAMENTE ${batchWordCount} palabras. No ${batchWordCount + 1}, no ${batchWordCount - 1}. EXACTAMENTE ${batchWordCount} palabras.

LÍMITE ABSOLUTO DE PALABRAS: ${batchWordCount} palabras. DEJA DE ESCRIBIR EN EL MOMENTO QUE ALCANCES ESTE NÚMERO.

Escribe el contenido para los capítulos o partes de capítulos dados basándote en el esquema, asegurándote de:
- Escribir EXACTAMENTE ${batchWordCount} palabras en total para este lote. Esto no es negociable.
- El recuento total de palabras en todos los capítulos debe contribuir a al menos ${totalWordCount} palabras para toda la historia.
- Mantener perfecta continuidad con el contenido previo proporcionado.
- Usar un estilo y voz consistentes a lo largo.
- Incluir transiciones naturales entre capítulos o partes.
- Incorporar descripciones vívidas.
- Escribir la historia completamente desde una perspectiva narrativa, enfocándose únicamente en la narración descriptiva.
- Nunca diálogos escritos.
- Comenzar la primera parte de la historia con un gancho convincente relacionado con el tema.
- Para cada capítulo o parte, incluir un encabezado en el formato **Capítulo X: Título del Capítulo**.

RECORDATORIO FINAL: Tu respuesta debe contener EXACTAMENTE ${batchWordCount} palabras. Cuenta mientras escribes y DETENTE inmediatamente en ${batchWordCount}.

IMPORTANTE: No incluyas ningún recordatorio de recuento de palabras, objetivos o instrucciones en tu respuesta. Comienza directamente con el encabezado del capítulo y el contenido de la historia. Tu respuesta debe contener SOLO el texto de la historia con encabezados de capítulos - sin meta-comentarios sobre recuentos de palabras.

Proporcionar solo el texto de la historia para los capítulos o partes en este lote, con los encabezados especificados, y ningún comentario o contenido adicional.`,

      french: `Vous êtes un écrivain créatif. Vous avez UN TRAVAIL CRITIQUE : Écrire EXACTEMENT ${batchWordCount} mots. Pas ${batchWordCount + 1}, pas ${batchWordCount - 1}. EXACTEMENT ${batchWordCount} mots.

LIMITE ABSOLUE DE MOTS : ${batchWordCount} mots. ARRÊTEZ D'ÉCRIRE DÈS QUE VOUS ATTEIGNEZ CE NOMBRE.

Écrivez le contenu pour les chapitres ou parties de chapitres donnés basé sur le plan, en vous assurant de :
- Écrire EXACTEMENT ${batchWordCount} mots au total pour ce lot. Ceci n'est pas négociable.
- Le nombre total de mots à travers tous les chapitres devrait contribuer à au moins ${totalWordCount} mots pour l'histoire complète.
- Maintenir une continuité parfaite avec le contenu précédent fourni.
- Utiliser un style et une voix cohérents tout au long.
- Inclure des transitions naturelles entre les chapitres ou parties.
- Incorporer des descriptions vivantes.
- Écrire l'histoire entièrement d'une perspective narrative, se concentrant uniquement sur la narration descriptive.
- Jamais de dialogues écrits.
- Commencer la première partie de l'histoire avec un accroche convaincant lié au sujet.
- Pour chaque chapitre ou partie, inclure un en-tête au format **Chapitre X : Titre du Chapitre**.

RAPPEL FINAL : Votre réponse doit contenir EXACTEMENT ${batchWordCount} mots. Comptez en écrivant et ARRÊTEZ immédiatement à ${batchWordCount}.

IMPORTANT : N'incluez aucun rappel de nombre de mots, objectifs ou instructions dans votre réponse. Commencez directement avec l'en-tête du chapitre et le contenu de l'histoire. Votre réponse doit contenir SEULEMENT le texte de l'histoire avec les en-têtes de chapitres - aucun méta-commentaire sur les nombres de mots.

Fournir seulement le texte de l'histoire pour les chapitres ou parties dans ce lot, avec les en-têtes spécifiés, et aucun commentaire ou contenu supplémentaire.`
    };

    const pauseInstructions = getPausePromptInstructions(pauses);
    const selectedPrompt = prompts[language as keyof typeof prompts] || prompts.english;
    return selectedPrompt + buildStyleContext(masterPrompt) + buildContentTypeWritingInstructions(contentType) + pauseInstructions + buildSearchContext(searchContext) + buildTranscriptContext(youtubeTranscript);
  } else {
    // Enhanced Claude prompts with stricter word count control
    const baseWordCount = isRetry ? Math.floor(batchWordCount * 0.9) : batchWordCount;
    
    const prompts = {
      english: isRetry ? 
        `CRITICAL INSTRUCTION: Write EXACTLY ${baseWordCount} words. NO MORE. NO LESS.

You are a word-counting machine. Your ONLY job is to write exactly ${baseWordCount} words of story content.

ABSOLUTE LIMITS:
- MAXIMUM WORDS: ${baseWordCount}
- STOP at word ${baseWordCount}
- DO NOT exceed this limit under ANY circumstances

Write the content for the given chapters based on the outline:
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
        `CRITICAL WORD COUNT INSTRUCTION: You MUST write EXACTLY ${batchWordCount} words. This is your PRIMARY OBJECTIVE.

WORD COUNT ENFORCEMENT PROTOCOL:
- Count every single word as you write
- STOP IMMEDIATELY when you reach word ${batchWordCount}
- Do NOT exceed this limit under ANY circumstances
- Better to stop mid-sentence than exceed the limit

You are writing story content for the given chapters. Requirements:
- Write EXACTLY ${batchWordCount} words total
- Maintain perfect continuity with the previous content provided
- Use a consistent style and voice throughout
- Include natural transitions between chapters or parts
- Incorporate vivid descriptions and engaging narrative
- Write the story entirely from a narrative perspective without any written dialogue, focusing solely on descriptive storytelling
- Begin the first part of the story with a compelling hook related to the subject, designed to immediately intrigue and captivate the reader
- For each chapter or part, include a heading in the format **Chapter X: Chapter Title** or **Chapter X: Chapter Title (Part Y)** (where X is the chapter number, Chapter Title is the title from the outline, and Part Y is the part identifier if applicable), followed by the chapter content

FINAL CHECK: Before submitting, count your words. If you have ${batchWordCount} words, submit immediately. If you have more, delete words until you reach exactly ${batchWordCount}.

IMPORTANT: Do not include any word count reminders, targets, or instructions in your response. Start directly with the chapter heading and story content. Your response should contain ONLY the story text with chapter headings - no meta-commentary about word counts.`,

      german: isRetry ?
        `KRITISCHE ANWEISUNG: Schreiben Sie GENAU ${baseWordCount} Wörter. NICHT MEHR. NICHT WENIGER.

Sie sind eine Wortzählmaschine. Ihr EINZIGER Job ist es, genau ${baseWordCount} Wörter Geschichteninhalt zu schreiben.

ABSOLUTE GRENZEN:
- MAXIMUM WÖRTER: ${baseWordCount}
- STOPPEN bei Wort ${baseWordCount}
- Überschreiten Sie dieses Limit UNTER KEINEN UMSTÄNDEN

Schreiben Sie den Inhalt für die gegebenen Kapitel basierend auf der Gliederung:
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
        `KRITISCHE WORTZAHL-ANWEISUNG: Sie MÜSSEN GENAU ${batchWordCount} Wörter schreiben. Das ist Ihr HAUPTZIEL.

WORTZAHL-DURCHSETZUNGSPROTOKOLL:
- Zählen Sie jedes einzelne Wort beim Schreiben
- STOPPEN SIE SOFORT, wenn Sie Wort ${batchWordCount} erreichen
- Überschreiten Sie dieses Limit UNTER KEINEN UMSTÄNDEN
- Lieber mitten im Satz aufhören als das Limit überschreiten

Sie schreiben Geschichteninhalte für die gegebenen Kapitel. Anforderungen:
- Schreiben Sie GENAU ${batchWordCount} Wörter insgesamt
- Bewahren Sie perfekte Kontinuität mit dem bereitgestellten vorherigen Inhalt
- Verwenden Sie einen konsistenten Stil und eine konsistente Stimme durchgehend
- Fügen Sie natürliche Übergänge zwischen Kapiteln oder Teilen ein
- Integrieren Sie lebendige Beschreibungen und fesselnde Erzählung
- Schreiben Sie die Geschichte vollständig aus einer narrativen Perspektive ohne geschriebene Dialoge, konzentriert auf beschreibendes Erzählen
- Beginnen Sie den ersten Teil der Geschichte mit einem fesselnden Haken zum Thema
- Für jedes Kapitel oder Teil fügen Sie eine Überschrift im Format **Kapitel X: Kapiteltitel** ein

ABSCHLIESSENDE ÜBERPRÜFUNG: Vor dem Einreichen zählen Sie Ihre Wörter. Wenn Sie ${batchWordCount} Wörter haben, reichen Sie sofort ein. Wenn Sie mehr haben, löschen Sie Wörter bis Sie genau ${batchWordCount} erreichen.

WICHTIG: Fügen Sie keine Wortzahl-Erinnerungen, Ziele oder Anweisungen in Ihre Antwort ein. Beginnen Sie direkt mit der Kapitelüberschrift und dem Geschichteninhalt. Ihre Antwort sollte NUR den Geschichtentext mit Kapitelüberschriften enthalten - keine Meta-Kommentare über Wortzahlen.`,

      spanish: isRetry ?
        `INSTRUCCIÓN CRÍTICA: Escribir EXACTAMENTE ${baseWordCount} palabras. NI MÁS. NI MENOS.

Eres una máquina contadora de palabras. Tu ÚNICO trabajo es escribir exactamente ${baseWordCount} palabras de contenido de historia.

LÍMITES ABSOLUTOS:
- MÁXIMO PALABRAS: ${baseWordCount}
- DETENTE en la palabra ${baseWordCount}
- NO excedas este límite bajo NINGUNA CIRCUNSTANCIA

Escribe el contenido para los capítulos dados basándote en el esquema:
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
        `INSTRUCCIÓN CRÍTICA DE RECUENTO DE PALABRAS: DEBES escribir EXACTAMENTE ${batchWordCount} palabras. Este es tu OBJETIVO PRINCIPAL.

PROTOCOLO DE APLICACIÓN DE RECUENTO DE PALABRAS:
- Cuenta cada palabra individual mientras escribes
- DETENTE INMEDIATAMENTE cuando alcances la palabra ${batchWordCount}
- NO excedas este límite bajo NINGUNA CIRCUNSTANCIA
- Mejor parar a mitad de oración que exceder el límite

Estás escribiendo contenido de historia para los capítulos dados. Requisitos:
- Escribir EXACTAMENTE ${batchWordCount} palabras en total
- Mantener perfecta continuidad con el contenido previo proporcionado
- Usar un estilo y voz consistentes a lo largo
- Incluir transiciones naturales entre capítulos o partes
- Incorporar descripciones vívidas y narrativa atractiva
- Escribir la historia completamente desde una perspectiva narrativa sin diálogos escritos, enfocándose únicamente en la narración descriptiva
- Comenzar la primera parte de la historia con un gancho convincente relacionado con el tema
- Para cada capítulo o parte, incluir un encabezado en el formato **Capítulo X: Título del Capítulo**

VERIFICACIÓN FINAL: Antes de enviar, cuenta tus palabras. Si tienes ${batchWordCount} palabras, envía inmediatamente. Si tienes más, elimina palabras hasta alcanzar exactamente ${batchWordCount}.

IMPORTANTE: No incluyas ningún recordatorio de recuento de palabras, objetivos o instrucciones en tu respuesta. Comienza directamente con el encabezado del capítulo y el contenido de la historia. Tu respuesta debe contener SOLO el texto de la historia con encabezados de capítulos - sin meta-comentarios sobre recuentos de palabras.`,

      french: isRetry ?
        `INSTRUCTION CRITIQUE : Écrire EXACTEMENT ${baseWordCount} mots. NI PLUS. NI MOINS.

Vous êtes une machine à compter les mots. Votre SEUL travail est d'écrire exactement ${baseWordCount} mots de contenu d'histoire.

LIMITES ABSOLUES :
- MAXIMUM MOTS : ${baseWordCount}
- ARRÊTEZ au mot ${baseWordCount}
- NE dépassez PAS cette limite sous AUCUNE CIRCONSTANCE

Écrivez le contenu pour les chapitres donnés basé sur le plan :
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
        `INSTRUCTION CRITIQUE DE NOMBRE DE MOTS : Vous DEVEZ écrire EXACTEMENT ${batchWordCount} mots. C'est votre OBJECTIF PRINCIPAL.

PROTOCOLE D'APPLICATION DU NOMBRE DE MOTS :
- Comptez chaque mot individuel en écrivant
- ARRÊTEZ IMMÉDIATEMENT quand vous atteignez le mot ${batchWordCount}
- NE dépassez PAS cette limite sous AUCUNE CIRCONSTANCE
- Mieux vaut s'arrêter au milieu d'une phrase que dépasser la limite

Vous écrivez du contenu d'histoire pour les chapitres donnés. Exigences :
- Écrire EXACTEMENT ${batchWordCount} mots au total
- Maintenir une continuité parfaite avec le contenu précédent fourni
- Utiliser un style et une voix cohérents tout au long
- Inclure des transitions naturelles entre les chapitres ou parties
- Incorporer des descriptions vivantes et une narration engageante
- Écrire l'histoire entièrement d'une perspective narrative sans dialogues écrits, se concentrant uniquement sur la narration descriptive
- Commencer la première partie de l'histoire avec un accroche convaincant lié au sujet
- Pour chaque chapitre ou partie, inclure un en-tête au format **Chapitre X : Titre du Chapitre**

VÉRIFICATION FINALE : Avant de soumettre, comptez vos mots. Si vous avez ${batchWordCount} mots, soumettez immédiatement. Si vous en avez plus, supprimez des mots jusqu'à atteindre exactement ${batchWordCount}.

IMPORTANT : N'incluez aucun rappel de nombre de mots, objectifs ou instructions dans votre réponse. Commencez directement avec l'en-tête du chapitre et le contenu de l'histoire. Votre réponse doit contenir SEULEMENT le texte de l'histoire avec les en-têtes de chapitres - aucun méta-commentaire sur les nombres de mots.`
    };

    const pauseInstructions = getPausePromptInstructions(pauses);
    const selectedPrompt = prompts[language as keyof typeof prompts] || prompts.english;
    return selectedPrompt + buildStyleContext(masterPrompt) + buildContentTypeWritingInstructions(contentType) + pauseInstructions + buildSearchContext(searchContext) + buildTranscriptContext(youtubeTranscript);
  }
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
  if (!data.chapters || !Array.isArray(data.chapters)) return 'Missing or invalid chapters';
  if (typeof data.previous_content !== 'string') return 'Missing or invalid previous_content';
  if (typeof data.total_word_count !== 'number' || data.total_word_count <= 0) return 'Missing or invalid total_word_count';
  if (typeof data.group_id !== 'string' || !data.group_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) return 'Missing or invalid group_id';
  if (typeof data.user_id !== 'string' || !data.user_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) return 'Missing or invalid user_id';
  if (typeof data.batch_number !== 'number' || data.batch_number < 1) return 'Missing or invalid batch_number';
  return null;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length;
}

async function triggerRetry(payload: any, retryAttempt: number = 1): Promise<void> {
  try {
    console.log(`Triggering retry attempt ${retryAttempt} for batch ${payload.batch_number}`);
    
    // Add retry flag to payload
    const retryPayload = {
      ...payload,
      retry_attempt: retryAttempt,
      is_retry: true
    };
    
    // Call generate-story again asynchronously
    fetch(`${supabaseUrl}/functions/v1/generate-story`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseKey,
      },
      body: JSON.stringify(retryPayload),
    }).catch(error => {
      console.error(`Error triggering retry for batch ${payload.batch_number}: ${error.message}`);
      logError(`Error triggering retry for batch ${payload.batch_number}`, error);
    });
  } catch (error: any) {
    console.error(`Error in triggerRetry: ${error.message}`);
    await logError('Error in triggerRetry', error);
  }
}

async function writeBatch(
  chapters: Chapter[],
  previousContent: string,
  totalWordCount: number,
  language: string = 'english',
  model: string = 'sonnet',
  isRetry: boolean = false,
  retryAttempt: number = 0,
  pauses: boolean = false,
  masterPrompt?: any,
  youtubeTranscript?: string | null,
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

  const chaptersOutline = chapters.map(c => ({
    number: c.number,
    title: c.title,
    part: c.part,
    summary: c.summary,
  }));

  const userPrompts = {
    english: `Write the following chapters or parts:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nContext provided below:\n\n${getContextInstructions(previousContent)}\n\nPrevious content:\n${previousContent}`,
    german: `Schreiben Sie die folgenden Kapitel oder Teile:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nBereitgestellter Kontext:\n\n${getContextInstructions(previousContent)}\n\nVorheriger Inhalt:\n${previousContent}`,
    spanish: `Escribe los siguientes capítulos o partes:\n${JSON.stringify(chaptersOutline, null, 2)}\n\nContexto proporcionado:\n\n${getContextInstructions(previousContent)}\n\nContenido previo:\n${previousContent}`,
    french: `Écrivez les chapitres ou parties suivants :\n${JSON.stringify(chaptersOutline, null, 2)}\n\nContexte fourni :\n\n${getContextInstructions(previousContent)}\n\nContenu précédent :\n${previousContent}`
  };

  const userPrompt = userPrompts[language as keyof typeof userPrompts] || userPrompts.english;

  const client = createModelClient(model);

  try {
    const systemPrompt = getSystemPrompts(language, batchWordCount, totalWordCount, model, isRetry, pauses, masterPrompt, youtubeTranscript, contentType, searchContext);
    const maxTokens = model === 'deepseek' ? 8000 : 8000;
    let temperature = model === 'deepseek' ? 1.1 : 0.5;
    
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
    // Fix incomplete break tags like <break time or <break time="900ms" (missing />)
    batchContent = batchContent.replace(/<break\s+time(?:="?\d+ms"?)?\s*(?!\/)>/g, '');
    // Fix orphaned/partial tags
    batchContent = batchContent.replace(/<break\s+time\s*$/gm, '');
    // Validate all remaining break tags have proper format
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
        console.warn(`Warning: No matching heading found for chapter ${chapter.number}. Expected variations not found.`);
      }
    }

    console.log(`Batch written: ${chapters.length} chapters/parts, ${countWords(batchContent)} words, language: ${language}, model: ${model}.`);
    return [batchContent, adjustedInputTokens, adjustedOutputTokens];
  } catch (error: any) {
    if (error.response?.status === 429 || error.response?.status >= 500 || error.message.includes('overloaded')) {
      console.log(`Transient error: ${error.message}. Will be retried by process-story.`);
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

  let payload;
  try {
    payload = await req.json();
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

    // Verify authentication (service role or JWT)
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 401 }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!auth.isServiceRole && auth.userId) { payload.user_id = auth.userId; }

    const validationError = validateInputs(payload);
    if (validationError) {
      return new Response(
        JSON.stringify({ error: validationError, code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { chapters, previous_content, total_word_count, group_id, user_id, batch_number, is_retry = false, retry_attempt = 0, tab = 1, variant = 1, youtube_transcript = null, content_type = 'story' } = payload;

    console.log(`Querying story_tasks with group_id: ${group_id}, user_id: ${user_id}, batch_number: ${batch_number}, tab: ${tab}, variant: ${variant}`);

    const { data: task, error: taskError } = await supabase
      .from('story_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('batch_number', batch_number)
      .eq('user_id', user_id)
      .eq('tab', tab)
      .eq('variant', variant)
      .single();

    if (taskError || !task) {
      console.error(`Task query error: ${taskError?.message || 'No task found'}`);
      console.log(`Queried parameters: group_id=${group_id}, user_id=${user_id}, batch_number=${batch_number}`);
      return new Response(
        JSON.stringify({ error: 'Task not found', code: 404 }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if task is already completed (by a retry or another process)
    if (task.status === 'completed' && task.previous_content) {
      console.log(`Task ${task.id} is already completed, returning existing content`);
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
      console.error(`No matching chapters for task batch: ${JSON.stringify(task.batch)}`);
      return new Response(
        JSON.stringify({ error: 'No chapters match task batch', code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const taskLanguage = task.language || 'english';
    const taskModel = task.model || 'sonnet';
    console.log(`Processing batch ${batch_number} for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel}${is_retry ? ' (retry)' : ''}`);

    // --- Web research for non-story content types ---
    const chapterTitles = batchChapters.map((ch: Chapter) => ch.title);
    const searchResult = await searchTopicContext(task.story_title || '', chapterTitles, content_type);
    const searchContext = searchResult.context;

    // --- Background generation with idle timeout protection ---
    // Supabase has a 150s idle timeout (no response) but 400s wall time.
    // We race the generation against 130s. If it finishes fast, return normally.
    // If it takes longer, return 202 and let it continue in background (up to 400s).
    const RESPONSE_TIMEOUT = 130000; // 130s, safely within 150s idle limit

    const generateInBackground = async (): Promise<Response> => {

    try {
      const [batchContent, inputTokens, rawOutputTokens] = await writeBatch(
        batchChapters,
        previous_content,
        total_word_count,
        taskLanguage,
        taskModel,
        is_retry,
        retry_attempt,
        task.pauses || false,
        task.master_prompt,
        youtube_transcript,
        content_type,
        searchContext,
        user_id
      );

      // Add Tavily search cost as output token equivalent for billing
      const outputTokens = rawOutputTokens + (searchResult.creditsUsed > 0 ? TAVILY_SEARCH_TOKEN_COST : 0);

      // Check if batch content exceeds target by more than 40% for Claude models and we haven't retried yet
      if (!is_retry && taskModel !== 'deepseek' && retry_attempt < 2) {
        const actualWords = countWords(batchContent);
        const targetWords = batchChapters.reduce((sum, ch) => sum + ch.word_count, 0);
        
        if (actualWords > targetWords * 1.4) {
          console.warn(`Warning: Batch generated ${actualWords} words, target was ${targetWords}. Exceeds 40% threshold.`);
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
              console.error(`Failed to update task ${task.id}: ${updateError.message}`);
            }
          } else {
            // Update without tokens to avoid constraint violation
            console.warn(`Skipping token update for task ${task.id}: ${tokenCheck.reason}`);
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
              console.error(`Failed to update task ${task.id} without tokens: ${updateError.message}`);
            }
            
            // Log the token limit issue
            await logError(`Token limit exceeded for user ${user_id}`, new Error(tokenCheck.reason || 'Token limit exceeded'));
          }

          // Trigger retry asynchronously (fire-and-forget)
          triggerRetry(payload, retry_attempt + 1).catch(error => {
            console.error(`Error triggering retry: ${error.message}`);
          });

          console.log(`Processed batch ${batch_number} (100.00%) for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel} (retry triggered)`);

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
          console.error(`Failed to update task ${task.id}: ${updateError.message}`);
        }
      } else {
        // Update without tokens to avoid constraint violation
        console.warn(`Skipping token update for task ${task.id}: ${tokenCheck.reason}`);
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
          console.error(`Failed to update task ${task.id} without tokens: ${updateError.message}`);
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
          .eq('tab', tab)
          .single();

        if (!nextTaskError && nextTask && (nextTask.status === 'pending' || nextTask.status === 'error' || nextTask.status === 'queued')) {
          console.log(`Triggering next batch ${nextBatchNumber} directly from generate-story`);
          
          // Set to running first
          await supabase
            .from('story_tasks')
            .update({ 
              status: 'running', 
              updated_at: new Date().toISOString() 
            })
            .eq('id', nextTask.id);
          
          // Then trigger process-story for the next batch
          fetch(`${supabaseUrl}/functions/v1/process-story`, {
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
            console.error(`Error triggering next batch ${nextBatchNumber} from generate-story: ${error.message}`);
          });
          
        } else if (nextTask && nextTask.status === 'running') {
          console.log(`Next batch ${nextBatchNumber} is already running`);
        }
      }

      console.log(`Processed batch ${batch_number} (100.00%) for chapters: [${batchChapters.map((ch: Chapter) => `${ch.number}${ch.part ? ' ' + ch.part : ''}`).join(', ')}] in ${taskLanguage} using ${taskModel}${is_retry ? ' (retry)' : ''}`);

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

    }; // end generateInBackground

    // Race generation against idle timeout
    const quickResult = await Promise.race([
      generateInBackground(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RESPONSE_TIMEOUT)),
    ]);

    if (quickResult) {
      return quickResult; // Completed within timeout, return directly
    }

    // Generation still running in background - it will save to DB and trigger next batch
    console.log(`Batch ${batch_number} generation exceeding ${RESPONSE_TIMEOUT / 1000}s, returning 202 and continuing in background (up to 400s wall time)...`);
    return new Response(
      JSON.stringify({ background: true, batch_number, message: 'Generation continues in background' }),
      { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: any) {
    await logError('Error in generate-story', error);
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


