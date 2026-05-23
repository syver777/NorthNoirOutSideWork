import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { OpenAI } from 'npm:openai@4';
import { getCorsHeaders } from '../_shared/cors.ts';
import { supabase, estimateTokens, countWords, withRetry, logError, verifyAuth } from '../_shared/utils.ts';

const DEEPSEEK_API_KEY = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
if (!DEEPSEEK_API_KEY) {
  throw new Error('Missing DEEPSEEK_API_KEY');
}

const openai = new OpenAI({
  apiKey: DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

function getSystemPrompts(language: string) {
  const prompts = {
    english: {
      rating: `You are an expert literary analyst. Independently evaluate the provided story for its pacing, consistency, character development, plot coherence, tone and atmosphere, and overall quality. For each category except overall quality, provide a rating out of 10 and a brief explanation (1-2 sentences). For overall quality, provide a concise qualitative assessment (1-2 sentences) without a numerical rating. Also, provide an overall rating for the entire story out of 10. Format the output as follows:

Pacing: X/10 - [Explanation]
Consistency: X/10 - [Explanation]
Character Development: X/10 - [Explanation]
Plot Coherence: X/10 - [Explanation]
Tone and Atmosphere: X/10 - [Explanation]
Overall Quality: [Qualitative assessment]
Overall Rating: X/10
Word Count: [Number]

Output only the evaluation text, no extra formatting or JSON.`,
      
      summary: `You are an expert literary analyst. Based on the independent evaluations of two stories (Document 1 and Document 2), provide a concise summary (2-3 sentences) comparing their strengths and weaknesses across pacing, consistency, character development, plot coherence, tone and atmosphere, and overall quality. Highlight key differences without assuming one is inherently better. Do not declare a winner. Output only the summary text, no extra formatting or JSON.`
    },
    
    german: {
      rating: `Sie sind ein Experte für Literaturanalyse. Bewerten Sie die bereitgestellte Geschichte unabhängig hinsichtlich Tempo, Konsistenz, Charakterentwicklung, Handlungskohärenz, Ton und Atmosphäre sowie Gesamtqualität. Geben Sie für jede Kategorie außer Gesamtqualität eine Bewertung von 10 und eine kurze Erklärung (1-2 Sätze) an. Für die Gesamtqualität geben Sie eine prägnante qualitative Bewertung (1-2 Sätze) ohne numerische Bewertung an. Geben Sie auch eine Gesamtbewertung für die gesamte Geschichte von 10 an. Formatieren Sie die Ausgabe wie folgt:

Tempo: X/10 - [Erklärung]
Konsistenz: X/10 - [Erklärung]
Charakterentwicklung: X/10 - [Erklärung]
Handlungskohärenz: X/10 - [Erklärung]
Ton und Atmosphäre: X/10 - [Erklärung]
Gesamtqualität: [Qualitative Bewertung]
Gesamtbewertung: X/10
Wortzahl: [Nummer]

Geben Sie nur den Bewertungstext aus, keine zusätzliche Formatierung oder JSON.`,
      
      summary: `Sie sind ein Experte für Literaturanalyse. Basierend auf den unabhängigen Bewertungen zweier Geschichten (Dokument 1 und Dokument 2), geben Sie eine prägnante Zusammenfassung (2-3 Sätze) an, die ihre Stärken und Schwächen in Tempo, Konsistenz, Charakterentwicklung, Handlungskohärenz, Ton und Atmosphäre sowie Gesamtqualität vergleicht. Heben Sie wichtige Unterschiede hervor, ohne anzunehmen, dass eine von Natur aus besser ist. Erklären Sie keinen Gewinner. Geben Sie nur den Zusammenfassungstext aus, keine zusätzliche Formatierung oder JSON.`
    },
    
    spanish: {
      rating: `Eres un experto analista literario. Evalúa independientemente la historia proporcionada en cuanto a ritmo, consistencia, desarrollo de personajes, coherencia de la trama, tono y atmósfera, y calidad general. Para cada categoría excepto calidad general, proporciona una calificación sobre 10 y una breve explicación (1-2 oraciones). Para calidad general, proporciona una evaluación cualitativa concisa (1-2 oraciones) sin calificación numérica. También proporciona una calificación general para toda la historia sobre 10. Formatea la salida como sigue:

Ritmo: X/10 - [Explicación]
Consistencia: X/10 - [Explicación]
Desarrollo de Personajes: X/10 - [Explicación]
Coherencia de la Trama: X/10 - [Explicación]
Tono y Atmósfera: X/10 - [Explicación]
Calidad General: [Evaluación cualitativa]
Calificación General: X/10
Recuento de Palabras: [Número]

Proporciona solo el texto de evaluación, sin formato adicional o JSON.`,
      
      summary: `Eres un experto analista literario. Basándote en las evaluaciones independientes de dos historias (Documento 1 y Documento 2), proporciona un resumen conciso (2-3 oraciones) comparando sus fortalezas y debilidades en ritmo, consistencia, desarrollo de personajes, coherencia de la trama, tono y atmósfera, y calidad general. Destaca las diferencias clave sin asumir que una es inherentemente mejor. No declares un ganador. Proporciona solo el texto del resumen, sin formato adicional o JSON.`
    },
    
    french: {
      rating: `Vous êtes un expert en analyse littéraire. Évaluez indépendamment l'histoire fournie pour son rythme, sa cohérence, le développement des personnages, la cohérence de l'intrigue, le ton et l'atmosphère, et la qualité générale. Pour chaque catégorie sauf la qualité générale, fournissez une note sur 10 et une brève explication (1-2 phrases). Pour la qualité générale, fournissez une évaluation qualitative concise (1-2 phrases) sans note numérique. Fournissez également une note générale pour l'histoire entière sur 10. Formatez la sortie comme suit :

Rythme : X/10 - [Explication]
Cohérence : X/10 - [Explication]
Développement des Personnages : X/10 - [Explication]
Cohérence de l'Intrigue : X/10 - [Explication]
Ton et Atmosphère : X/10 - [Explication]
Qualité Générale : [Évaluation qualitative]
Note Générale : X/10
Nombre de Mots : [Nombre]

Fournissez seulement le texte d'évaluation, pas de formatage supplémentaire ou JSON.`,
      
      summary: `Vous êtes un expert en analyse littéraire. Basé sur les évaluations indépendantes de deux histoires (Document 1 et Document 2), fournissez un résumé concis (2-3 phrases) comparant leurs forces et faiblesses à travers le rythme, la cohérence, le développement des personnages, la cohérence de l'intrigue, le ton et l'atmosphère, et la qualité générale. Mettez en évidence les différences clés sans supposer qu'une est intrinsèquement meilleure. Ne déclarez pas de gagnant. Fournissez seulement le texte du résumé, pas de formatage supplémentaire ou JSON.`
    }
  };

  return prompts[language as keyof typeof prompts] || prompts.english;
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

    const { original_story, corrected_story, user_id, group_id, language = 'english', tab = 1 } = payload;
    if (!original_story || !corrected_story || !user_id || !group_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields', code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate tab parameter
    if (typeof tab !== 'number' || tab < 1 || tab > 10) {
      return new Response(
        JSON.stringify({ error: 'Invalid tab parameter. Must be between 1 and 10.', code: 400 }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate language
    const supportedLanguages = ['english', 'german', 'spanish', 'french'];
    const validatedLanguage = supportedLanguages.includes(language) ? language : 'english';

    const originalWords = countWords(original_story);
    const correctedWords = countWords(corrected_story);

    const prompts = getSystemPrompts(validatedLanguage);

    const userPrompts = {
      english: (story: string) => `Evaluate this story:\n${story.slice(0, 15000)}`,
      german: (story: string) => `Bewerten Sie diese Geschichte:\n${story.slice(0, 15000)}`,
      spanish: (story: string) => `Evalúa esta historia:\n${story.slice(0, 15000)}`,
      french: (story: string) => `Évaluez cette histoire :\n${story.slice(0, 15000)}`
    };

    const userPromptFn = userPrompts[validatedLanguage as keyof typeof userPrompts] || userPrompts.english;

    // Analyze Document 1
    const doc1Prompt = userPromptFn(original_story);
    const doc1Response = await withRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompts.rating },
          { role: 'user', content: doc1Prompt },
        ],
        max_tokens: 2000,
        temperature: 0.8,
        stream: true, // Enable streaming for DeepSeek
      })
    );

    let doc1Eval = '';
    for await (const chunk of doc1Response) {
      if (chunk.choices[0]?.delta?.content) {
        doc1Eval += chunk.choices[0].delta.content;
      }
    }

    const doc1InputTokens = estimateTokens(prompts.rating + doc1Prompt);
    const doc1OutputTokens = estimateTokens(doc1Eval);

    // Analyze Document 2
    const doc2Prompt = userPromptFn(corrected_story);
    const doc2Response = await withRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompts.rating },
          { role: 'user', content: doc2Prompt },
        ],
        max_tokens: 2000,
        temperature: 0.8,
        stream: true, // Enable streaming for DeepSeek
      })
    );

    let doc2Eval = '';
    for await (const chunk of doc2Response) {
      if (chunk.choices[0]?.delta?.content) {
        doc2Eval += chunk.choices[0].delta.content;
      }
    }

    const doc2InputTokens = estimateTokens(prompts.rating + doc2Prompt);
    const doc2OutputTokens = estimateTokens(doc2Eval);

    // Generate summary
    const summaryPrompts = {
      english: `Document 1 Evaluation:\n${doc1Eval}\n\nDocument 2 Evaluation:\n${doc2Eval}`,
      german: `Dokument 1 Bewertung:\n${doc1Eval}\n\nDokument 2 Bewertung:\n${doc2Eval}`,
      spanish: `Evaluación del Documento 1:\n${doc1Eval}\n\nEvaluación del Documento 2:\n${doc2Eval}`,
      french: `Évaluation du Document 1 :\n${doc1Eval}\n\nÉvaluation du Document 2 :\n${doc2Eval}`
    };

    const summaryPrompt = summaryPrompts[validatedLanguage as keyof typeof summaryPrompts] || summaryPrompts.english;
    const summaryResponse = await withRetry(() =>
      openai.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompts.summary },
          { role: 'user', content: summaryPrompt },
        ],
        max_tokens: 1000,
        temperature: 0.8,
        stream: true, // Enable streaming for DeepSeek
      })
    );

    let summaryText = '';
    for await (const chunk of summaryResponse) {
      if (chunk.choices[0]?.delta?.content) {
        summaryText += chunk.choices[0].delta.content;
      }
    }

    const summaryInputTokens = estimateTokens(prompts.summary + summaryPrompt);
    const summaryOutputTokens = estimateTokens(summaryText);

    const comparison = `Document 1 Evaluation\n${doc1Eval}\n\nDocument 2 Evaluation\n${doc2Eval}\n\nSummary\n${summaryText}`;
    const totalInputTokens = doc1InputTokens + doc2InputTokens + summaryInputTokens;
    const totalOutputTokens = doc1OutputTokens + doc2OutputTokens + summaryOutputTokens;

    // Store comparison
    const { error } = await supabase
      .from('story_comparisons')
      .insert({
        user_id,
        group_id,
        comparison_text: comparison,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        language: validatedLanguage,
        tab: tab,
        created_at: new Date().toISOString(),
      });

    if (error) {
      throw new Error(`Failed to save comparison: ${error.message}`);
    }

    console.log(`Comparison completed in language: ${validatedLanguage}`);

    return new Response(
      JSON.stringify({ 
        comparison, 
        inputTokens: totalInputTokens, 
        outputTokens: totalOutputTokens,
        language: validatedLanguage
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: any) {
    await logError('Error in compare-stories', error);
    let status = 500;
    let errorMessage = error.message || 'Internal server error';
    if (error.message.includes('rate limit') || error.status === 429) {
      status = 429;
      errorMessage = 'Rate limit exceeded. Please try again later.';
    } else if (error.message.includes('invalid')) {
      status = 400;
    }
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});




