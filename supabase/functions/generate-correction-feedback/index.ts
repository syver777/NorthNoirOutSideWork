import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { OpenAI } from 'npm:openai@4';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, logError, verifyAuth } from '../_shared/utils.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SECRET_KEY') ?? '';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

// Model configurations
const MODEL_CONFIGS = {
  deepseek: {
    maxWordsPerBatch: 1100,
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

interface Payload {
  group_id: string;
  user_id: string;
  user_feedback?: string;
  variant?: number;
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

// Call model API
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
        prompt_tokens: Math.ceil(messages.map(m => m.content).join('').split(/\s+/).length * 1.33),
        completion_tokens: Math.ceil(content.split(/\s+/).length * 1.33)
      }
    };
  } else {
    // For Claude models, use fetch to call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': client.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
        max_tokens: options.max_tokens || 2000,
        temperature: options.temperature || 0.7,
        system: messages[0].content,
        messages: [{ role: 'user', content: messages[1].content }]
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    const result = await response.json();
    
    // Convert to OpenAI-like format
    return {
      choices: [{ message: { content: result.content[0].text } }],
      usage: {
        prompt_tokens: result.usage?.input_tokens || 0,
        completion_tokens: result.usage?.output_tokens || 0
      }
    };
  }
}

function getSystemPrompts(language: string, youtubeTranscript?: string | null, contentType: string = 'story') {
  const transcriptBlock = youtubeTranscript
    ? `\n  - Ensuring the story incorporates specific facts, numbers, names, companies, and technical details from the source transcript rather than generalizing or fictionalizing them.`
    : '';
  const transcriptAppendix = youtubeTranscript
    ? `\n\n=== SOURCE TRANSCRIPT (FACTUAL REFERENCE) ===\nThe following is a raw transcript from the source video. The corrected version MUST incorporate specific facts, data points, names, and claims from this transcript. Flag any areas where the story generalizes or fictionalizes information that should use actual data from the transcript.\n\n${youtubeTranscript}\n\n=== END SOURCE TRANSCRIPT ===`
    : '';
  const contentTypeBlock = contentType !== 'story'
    ? `\n  - This is a ${contentType.toUpperCase()} script, NOT fiction. Ensure the corrected version maintains the appropriate ${contentType} tone and structure. All content must be written for a single third-person narrator (no dialogue, no screenplay format).`
    : '';
  const prompts = {
    english: `You are an expert story planner. Analyze the provided story outline for a YouTube video script and identify areas for improvement to write a corrected version. Provide detailed notes focusing on:
  - Maintaining the specified tone and atmosphere (e.g., documentary-style, suspenseful).
  - Preserving key themes (e.g., patriotism, survival, psychological toll).
  - Ensuring consistency in character behavior and development.
  - Incorporating critical plot details and setting specifics.
  - Balancing narrative elements (e.g., action, tension, realism).
  - Ensuring each chapter aligns with its summary in the outline.
  - Correcting historical inaccuracies.
  - Addressing structural issues, without suggesting to change the the structure of the outline
  - Checking for any truncated, garbled, or incomplete sentences that may indicate text corruption (e.g., words cut off mid-syllable, sentences that abruptly jump to unrelated content, broken SSML tags like malformed <break time="..." /> markers).
  - Ensuring all SSML break tags are properly formatted with complete time attributes and self-closing syntax.${transcriptBlock}${contentTypeBlock}
  Provide notes in a concise, bullet-point format under the heading '### Notes for Corrected Version'. Keep the total context under 48,000 words (~64,000 tokens).${transcriptAppendix}`,

    german: `Sie sind ein Experte für Geschichtenplanung. Analysieren Sie die bereitgestellte Geschichtengliederung für ein YouTube-Videoskript und identifizieren Sie Verbesserungsbereiche, um eine korrigierte Version zu schreiben. Geben Sie detaillierte Notizen mit Fokus auf:
  - Beibehaltung des spezifizierten Tons und der Atmosphäre (z.B. dokumentarischer Stil, spannend).
  - Bewahrung wichtiger Themen (z.B. Patriotismus, Überleben, psychologische Belastung).
  - Sicherstellung der Konsistenz im Charakterverhalten und der Entwicklung.
  - Einbeziehung kritischer Handlungsdetails und Umgebungsspezifika.
  - Ausbalancierung narrativer Elemente (z.B. Action, Spannung, Realismus).
  - Sicherstellung, dass jedes Kapitel mit seiner Zusammenfassung in der Gliederung übereinstimmt.
  - Korrektur historischer Ungenauigkeiten.
  - Behandlung struktureller Probleme, ohne vorzuschlagen, die Struktur der Gliederung zu ändern
  - Überprüfung auf abgeschnittene, verstümmelte oder unvollständige Sätze, die auf Textkorruption hinweisen könnten (z.B. mitten im Wort abgeschnittene Wörter, Sätze die abrupt zu nicht zusammenhängendem Inhalt springen, defekte SSML-Tags).
  - Sicherstellung, dass alle SSML-Break-Tags korrekt formatiert sind.${transcriptBlock}${contentTypeBlock}
  Geben Sie Notizen in einem prägnanten Stichpunktformat unter der Überschrift '### Notizen für korrigierte Version' an. Halten Sie den Gesamtkontext unter 48.000 Wörtern (~64.000 Tokens).${transcriptAppendix}`,

    spanish: `Eres un experto planificador de historias. Analiza el esquema de historia proporcionado para un guión de video de YouTube e identifica áreas de mejora para escribir una versión corregida. Proporciona notas detalladas enfocándose en:
  - Mantener el tono y atmósfera especificados (ej. estilo documental, suspenso).
  - Preservar temas clave (ej. patriotismo, supervivencia, carga psicológica).
  - Asegurar consistencia en el comportamiento y desarrollo de personajes.
  - Incorporar detalles críticos de la trama y especificidades del escenario.
  - Equilibrar elementos narrativos (ej. acción, tensión, realismo).
  - Asegurar que cada capítulo se alinee con su resumen en el esquema.
  - Corregir inexactitudes históricas.
  - Abordar problemas estructurales, sin sugerir cambiar la estructura del esquema
  - Verificar oraciones truncadas, ilegibles o incompletas que puedan indicar corrupción de texto (ej. palabras cortadas a mitad de sílaba, oraciones que saltan abruptamente a contenido no relacionado, etiquetas SSML rotas).
  - Asegurar que todas las etiquetas SSML break estén correctamente formateadas.${transcriptBlock}${contentTypeBlock}
  Proporciona notas en un formato conciso de viñetas bajo el encabezado '### Notas para Versión Corregida'. Mantén el contexto total bajo 48,000 palabras (~64,000 tokens).${transcriptAppendix}`,

    french: `Vous êtes un expert en planification d'histoires. Analysez le plan d'histoire fourni pour un script vidéo YouTube et identifiez les domaines d'amélioration pour écrire une version corrigée. Fournissez des notes détaillées en vous concentrant sur :
  - Maintenir le ton et l'atmosphère spécifiés (par ex. style documentaire, suspense).
  - Préserver les thèmes clés (par ex. patriotisme, survie, charge psychologique).
  - Assurer la cohérence dans le comportement et le développement des personnages.
  - Incorporer les détails critiques de l'intrigue et les spécificités du cadre.
  - Équilibrer les éléments narratifs (par ex. action, tension, réalisme).
  - S'assurer que chaque chapitre s'aligne avec son résumé dans le plan.
  - Corriger les inexactitudes historiques.
  - Aborder les problèmes structurels, sans suggérer de changer la structure du plan
  - Vérifier les phrases tronquées, illisibles ou incomplètes pouvant indiquer une corruption de texte (par ex. mots coupés en plein milieu, phrases sautant brusquement vers un contenu sans rapport, balises SSML cassées).
  - S'assurer que toutes les balises SSML break sont correctement formatées.${transcriptBlock}${contentTypeBlock}
  Fournissez des notes dans un format de puces concis sous le titre '### Notes pour Version Corrigée'. Gardez le contexte total sous 48 000 mots (~64 000 tokens).${transcriptAppendix}`
  };

  return prompts[language as keyof typeof prompts] || prompts.english;
}

function validateInputs(data: Payload): string | null {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!data.group_id || !uuidRegex.test(data.group_id)) return 'Missing or invalid group_id';
  if (!data.user_id || !uuidRegex.test(data.user_id)) return 'Missing or invalid user_id';
  return null;
}

async function generateSystemFeedback(outline: string, language: string = 'english', model: string = 'sonnet', youtubeTranscript?: string | null, contentType: string = 'story', userId?: string): Promise<[string, number, number]> {
  const systemPrompt = getSystemPrompts(language, youtubeTranscript, contentType);
  
  const userPrompts = {
    english: `Outline:\n${outline}`,
    german: `Gliederung:\n${outline}`,
    spanish: `Esquema:\n${outline}`,
    french: `Plan :\n${outline}`
  };

  const userPrompt = userPrompts[language as keyof typeof userPrompts] || userPrompts.english;
  
  try {
    const client = createModelClient(model);
    
    const response = await callModelAPI(client, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], {
      model: model === 'deepseek' ? 'deepseek-chat' : model,
      max_tokens: 2000,
      temperature: 0.7,
    }, model);

    const feedback = response.choices[0].message.content || '';
    
    let inputTokens = response.usage?.prompt_tokens || 0;
    let outputTokens = response.usage?.completion_tokens || 0;

    // Apply token multiplier for cost normalization (legacy vs new plan)
    const isLegacy = await getIsLegacyPlan(userId ?? '');
    const tokenMultiplier = llmMultiplier(isLegacy, model);
    const adjustedInputTokens = Math.round(inputTokens * tokenMultiplier);
    const adjustedOutputTokens = Math.round(outputTokens * tokenMultiplier);

    return [feedback, adjustedInputTokens, adjustedOutputTokens];
  } catch (error: any) {
    console.error(`Error generating feedback: ${error.message}`);
    throw new Error(`Failed to generate system feedback: ${error.message}`);
  }
}

async function createCorrectedOutlineTask(groupId: string, userId: string, outlineTask: any, feedback: string, tab: number = 1, variant: number = 1) {
  const { outline, story_title, description, total_batches, input_tokens, output_tokens, language, model, pauses } = outlineTask;

  const { data: newOutlineTask, error: outlineError } = await supabase
    .from('story_tasks')
    .insert({
      user_id: userId,
      group_id: groupId,
      story_title,
      batch: [],
      previous_content: outline,
      total_word_count: outlineTask.total_word_count,
      batch_number: 0,
      status: 'completed',
      description,
      outline,
      feedback,
      total_batches,
      is_corrected: true,
      version: 2,
      variant: variant,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      progress: 100,
      input_tokens,
      output_tokens,
      language: language || 'english',
      model: model || 'sonnet',
      tab: tab,
      pauses: pauses || false,
      content_type: outlineTask.content_type || 'story',
    })
    .select()
    .single();
  if (outlineError) throw new Error(`Failed to create corrected outline task: ${outlineError.message}`);

  return newOutlineTask;
}

async function createCorrectedBatchTasks(groupId: string, userId: string, language: string = 'english', model: string = 'sonnet', tab: number = 1, variant: number = 1): Promise<void> {
  // Get original tasks to copy structure
  const { data: originalTasks, error: originalError } = await supabase
    .from('story_tasks')
    .select('*')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('is_corrected', false)
    .eq('version', 1)
    .eq('variant', variant)
    .eq('tab', tab)
    .gt('batch_number', 0)
    .order('batch_number', { ascending: true });

  if (originalError || !originalTasks.length) {
    throw new Error(`Failed to fetch original tasks: ${originalError?.message || 'No tasks found'}`);
  }

  // Check if corrected tasks already exist
  const { data: existingCorrected } = await supabase
    .from('story_tasks')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .eq('is_corrected', true)
    .eq('version', 2)
    .eq('variant', 1)
    .eq('tab', tab)
    .gt('batch_number', 0)
    .limit(1);

  if (existingCorrected && existingCorrected.length > 0) {
    console.log(`Corrected tasks already exist for group ${groupId}`);
    return;
  }

  // Create corrected batch tasks
  const correctedTasks = originalTasks.map(task => ({
    id: crypto.randomUUID(),
    user_id: userId,
    group_id: groupId,
    batch: task.batch,
    previous_content: null,
    total_word_count: task.total_word_count,
    batch_number: task.batch_number,
    progress: 0,
    status: 'pending',
    story_title: task.story_title,
    description: task.description,
    total_batches: task.total_batches,
    is_corrected: true,
    version: 2,
    variant: variant,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    stop_requested: false,
    video_process: task.video_process || false,
    language: language,
    model: model,
    tab: tab,
    pauses: task.pauses || false,
    content_type: task.content_type || 'story',
    master_prompt: task.master_prompt || null,
  }));

  const { error: insertError } = await supabase
    .from('story_tasks')
    .insert(correctedTasks);

  if (insertError) {
    throw new Error(`Failed to create corrected batch tasks: ${insertError.message}`);
  }

  console.log(`Created ${correctedTasks.length} corrected batch tasks with language: ${language}, model: ${model}`);
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    // Auth check
    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: responseHeaders });
    }

    const payload = await req.json();
    if (!auth.isServiceRole && auth.userId) { payload.user_id = auth.userId; }
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { group_id, user_id, user_feedback, tab = 1, variant = 1 } = payload;

    const { data: outlineTasks, error: tasksError } = await supabase
      .from('story_tasks')
      .select('*')
      .eq('group_id', group_id)
      .eq('user_id', user_id)
      .eq('batch_number', 0)
      .eq('is_corrected', false)
      .eq('version', 1)
      .eq('variant', variant)
      .eq('tab', tab)
      .order('created_at', { ascending: false });
    if (tasksError || !outlineTasks.length) return new Response(JSON.stringify({ error: 'Original outline task not found', code: 404 }), { status: 404, headers: responseHeaders });

    const outlineTask = outlineTasks[0];
    if (outlineTasks.length > 1) console.warn(`Multiple outline tasks found for group ${group_id}. Using task with id ${outlineTask.id}`);

    const taskLanguage = outlineTask.language || 'english';
    const taskModel = outlineTask.model || 'sonnet';
    console.log(`Generating feedback in language: ${taskLanguage}, model: ${taskModel}`);

    const [systemFeedback, inputTokens, outputTokens] = await generateSystemFeedback(outlineTask.outline, taskLanguage, taskModel, outlineTask.youtube_transcript, outlineTask.content_type || 'story', user_id);
    const combinedFeedback = user_feedback ? `${systemFeedback}\n\n### User Feedback:\n${user_feedback}` : systemFeedback;

    const newOutlineTask = await createCorrectedOutlineTask(group_id, user_id, outlineTask, combinedFeedback, tab, variant);

    // Create all corrected batch tasks
    await createCorrectedBatchTasks(group_id, user_id, taskLanguage, taskModel, tab, variant);

    // Trigger the first corrected batch
    try {
      const triggerResponse = await fetch(`${SUPABASE_URL}/functions/v1/trigger-next-corrected-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({
          group_id: group_id,
          user_id: user_id,
          current_batch_number: 0,
          tab: tab,
          variant: variant,
        }),
      });

      if (!triggerResponse.ok) {
        console.warn(`Failed to trigger first corrected batch: HTTP ${triggerResponse.status}`);
      } else {
        console.log('Successfully triggered first corrected batch');
      }
    } catch (triggerError: any) {
      console.error(`Error triggering first corrected batch: ${triggerError.message}`);
      // Don't fail the whole operation if triggering fails
    }

    return new Response(JSON.stringify({
      feedback: combinedFeedback,
      task_id: newOutlineTask.id,
      language: taskLanguage,
      model: taskModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    }), { status: 200, headers: responseHeaders });
  } catch (error: any) {
    console.error(`Error in generate-correction-feedback: ${error.message}`);
    await logError('Error in generate-correction-feedback', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});




