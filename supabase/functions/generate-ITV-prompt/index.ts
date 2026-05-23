// generate-ITV-prompt/index.ts
// Dual-mode AI prompt generator for the ITV pipeline.
//
// Phase 1 (itv=false): generates keyframe IMAGE prompts for each text segment.
//   Input:  batch_segments = [{text, index}]
//   Output: [{text, image_prompt}]
//
// Phase 2 (itv=true): generates MOTION/ANIMATION prompts for each {text, image_prompt} pair.
//   Input:  batch_segments = [{text, image_prompt, index}]
//   Output: [{text, prompt}]
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const anthropicApiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL or ANON_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_PER_WORD = 1.33;

const MODEL_CONFIGS = {
  deepseek: { apiKey: deepseekApiKey, baseURL: 'https://api.deepseek.com', tokenMultiplier: 1.0 },
  sonnet:   { apiKey: anthropicApiKey, baseURL: 'https://api.anthropic.com', tokenMultiplier: 11.0 },
  opus:     { apiKey: anthropicApiKey, baseURL: 'https://api.anthropic.com', tokenMultiplier: 19.0 },
};

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface Phase1Segment {
  text: string;
  index: number;
}

interface Phase2Segment {
  text: string;
  image_prompt: string;
  index: number;
}

interface RequestBody {
  // Phase selector
  itv: boolean;  // false = Phase 1 (image prompts), true = Phase 2 (motion prompts)
  // Shared
  task_id: string;
  group_id: string;
  tab?: number;
  variant?: number;
  language?: string;
  model?: string;
  audio_clip?: boolean;
  style?: string;              // visual style description
  text_part?: string;          // part_number reference for ITV_prompt_context lookup
  // Phase 1
  batch_segments?: Phase1Segment[];
  // Phase 2
  phase2_segments?: Phase2Segment[];
  // Shared: character consistency
  characters?: Record<string, string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(w => w.length > 0).length * TOKEN_PER_WORD);
}

function formatCharacterDescriptions(characters: Record<string, string> | null | undefined): string {
  if (!characters) return '';
  const entries = Object.entries(characters);
  if (entries.length === 0) return '';
  const charLines = entries.map(([name, desc]) => `  "${name}": "${desc}"`);
  return '{\n' + charLines.join(',\n') + '\n}';
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

function cleanAndParseJSON(raw: string): any {
  let s = raw.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();

  // Fix invalid backslash escapes produced by AI (e.g. \s, \T, \l, \c).
  // Valid JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX — anything else is illegal.
  const fixBackslashes = (str: string) => str.replace(/\\(?!["\\/bfnrtu])/g, '');

  try {
    return JSON.parse(s);
  } catch (_) {
    // Try with backslash fix only
    try { return JSON.parse(fixBackslashes(s)); } catch (_) { /* fall through */ }

    // Try extracting first JSON array
    const match = s.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
      try { return JSON.parse(fixBackslashes(match[0])); } catch (_) { /* fall through */ }
    }

    // Fix common issues: trailing commas, raw whitespace chars
    let fixed = (match?.[0] ?? s)
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    try { return JSON.parse(fixed); } catch (_) { /* fall through */ }

    // Final attempt: fix backslashes after whitespace escaping
    fixed = fixBackslashes(fixed);
    try { return JSON.parse(fixed); } catch (e: any) {
      throw new Error(`JSON parse failed: ${e.message}`);
    }
  }
}

// ─── Context fetching ────────────────────────────────────────────────────────

async function fetchITVContext(groupId: string, partNumber: number, tab: number, itv: boolean) {
  const { data, error } = await supabase
    .from('ITV_prompt_context')
    .select('*')
    .eq('group_id', groupId)
    .eq('tab', tab)
    .eq('part_number', partNumber)
    .eq('itv', itv)
    .maybeSingle();
  if (error) console.warn(`fetchITVContext failed (group=${groupId}, part=${partNumber}, itv=${itv}): ${error.message}`);
  if (!data) {
    // Fallback: try without tab filter for backward compatibility
    const { data: fallback } = await supabase
      .from('ITV_prompt_context')
      .select('*')
      .eq('group_id', groupId)
      .eq('part_number', partNumber)
      .eq('itv', itv)
      .maybeSingle();
    if (fallback) console.log(`ITV context fallback (no-tab) found: part=${partNumber}, itv=${itv}`);
    return fallback ?? null;
  }
  console.log(`ITV context fetched: part=${partNumber}, itv=${itv}, story_chars=${data.full_story_text?.length ?? 0}`);
  return data;
}

// ─── Model client ─────────────────────────────────────────────────────────────

async function callModelAPI(messages: any[], options: any, model: string): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) throw new Error(`Unsupported model: ${model}`);
  if (!config.apiKey) throw new Error(`API key not set for model: ${model}`);

  if (model === 'deepseek') {
    const response = await fetch(`${config.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        max_tokens: options.max_tokens ?? 8000,
        temperature: options.temperature ?? 0.6,
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
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) content += parsed.choices[0].delta.content;
            } catch (_) { /* skip */ }
          }
        }
      }
    }
    return {
      content,
      inputTokens: estimateTokens(messages.map((m: any) => m.content).join('')),
      outputTokens: estimateTokens(content),
    };
  } else {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model === 'sonnet' ? 'claude-sonnet-4-6' : 'claude-opus-4-6',
        max_tokens: options.max_tokens ?? 16000,
        temperature: options.temperature ?? 0.4,
        system: messages[0].content,
        messages: [{ role: 'user', content: messages[1].content }],
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: HTTP ${response.status} - ${errorText}`);
    }
    const result = await response.json();
    return {
      content: result.content[0].text,
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
    };
  }
}

// ─── Phase 1: Image prompt generation ────────────────────────────────────────

function getPhase1SystemPrompt(
  language: string,
  audioClip: boolean,
  fullStoryText: string = '',
  style: string = '',
  previousImagePrompts: string[] = [],
  characters: Record<string, string> = {},
): string {
  const styleNote = style ? `\n- Visual style: ${style}` : '';
  const hasChars = characters && Object.keys(characters).length > 0;
  const charReferenceBlock = hasChars
    ? '\nCharacter Reference (use ONLY these names when characters appear in a scene):\n' +
      JSON.stringify(characters, null, 2) + '\n'
    : '';
  const schemaInstruction = hasChars
    ? ', and "characters_mentioned" (a JSON array of character name strings that appear in this scene — use the exact keys from the Character Reference; empty array [] if no characters)'
    : '';
  const charSystemInstruction = hasChars
    ? '\n- When mentioning characters, use their name from the Character Reference. The matching full character descriptions will be automatically appended to your prompt after generation.'
    : '';
  const contextSection = fullStoryText || previousImagePrompts.length > 0 ? `

Full Story Context (for scene continuity and character consistency):
${fullStoryText.slice(0, 15000)}

${previousImagePrompts.length > 0 ? `Previous Keyframe Image Prompts (use for visual consistency):
${previousImagePrompts.slice(-5).map((p, i) => `${i + 1}. ${p.slice(0, 200)}...`).join('\n')}
` : ''}` : '';

  const prompts: Record<string, string> = {
    english: `You are an expert AI image director specializing in creating detailed keyframe descriptions for image-to-video generation. Your task is to generate precise, vivid image descriptions that will serve as starting keyframes for short video clips.

CRITICAL: These images will be used as STARTING KEYFRAMES for image-to-video generation. Each image must be:
1. A single frozen moment that implies motion and action about to happen
2. Visually rich and cinematic in composition
3. 200-300 words describing: subject/characters, environment, lighting, mood, camera angle, visual style
4. Written as a direct image description, not a narrative

For each text segment, create ONE keyframe image description in this order:
- Primary subject: who or what is the main focus, their exact pose and expression
- Environment: setting details, background, foreground elements
- Lighting: source, direction, quality, color temperature
- Composition: camera angle, framing, depth of field
- Visual style: color palette, atmosphere, cinematic mood${styleNote}${audioClip ? '\n- Implied sound: subtle visual cues that suggest the audio atmosphere' : ''}
${charSystemInstruction}
${charReferenceBlock}
RULES:
- Write ONE cohesive paragraph per image. No sub-headings or labeled sections.
- ⚠️ CRITICAL: The image must NOT contain any visible text, letters, words, numbers, signs, or written language.
- Use specific, concrete visual details rather than abstract descriptions.
- Use the full story context and previous prompts to ensure visual consistency across scenes.

Output a JSON array with exactly the same number of items as input segments.
Each item must have keys: "text" (exact copy of the input segment text), "image_prompt" (your 200-300 word keyframe description)${schemaInstruction}.
Return only the JSON array, no preamble.${contextSection}`,

    german: `Sie sind ein erfahrener KI-Bildregisseur, der sich auf die Erstellung detaillierter Schlüsselbild-Beschreibungen für die Bild-zu-Video-Generierung spezialisiert hat.

WICHTIG: Diese Bilder werden als STARTSCHLÜSSELBILDER für die Bild-zu-Video-Generierung verwendet. Jedes Bild muss ein eingefrorener Moment sein, der Bewegung impliziert.

Für jedes Textsegment erstellen Sie EINE Schlüsselbild-Beschreibung (200-300 Wörter):
- Hauptmotiv: wer oder was ist der Hauptfokus, genaue Pose und Ausdruck
- Umgebung: Setting-Details, Hintergrund, Vordergrundelemente
- Beleuchtung: Quelle, Richtung, Qualität, Farbtemperatur
- Komposition: Kamerawinkel, Rahmung, Schärfentiefe
- Visueller Stil: Farbpalette, Atmosphäre, filmische Stimmung${styleNote}
${charSystemInstruction}
${charReferenceBlock}
Ausgabe als JSON-Array mit genau so vielen Elementen wie Eingabesegmente.
Jedes Element hat Schlüssel: "text" (exakte Kopie des Eingabetextes), "image_prompt" (Ihre 200-300-Wort-Beschreibung)${schemaInstruction}.
Nur das JSON-Array zurückgeben, ohne Präambel.${contextSection}`,

    spanish: `Eres un director de imágenes IA experto especializado en crear descripciones detalladas de fotogramas clave para la generación de imagen a video.

CRÍTICO: Estas imágenes serán usadas como FOTOGRAMAS CLAVE INICIALES para la generación de video. Cada imagen debe ser un momento congelado que implique movimiento.

Para cada segmento de texto, crea UNA descripción de fotograma clave (200-300 palabras):
- Sujeto principal: quién o qué es el foco principal, pose exacta y expresión
- Entorno: detalles del escenario, fondo, elementos del primer plano
- Iluminación: fuente, dirección, calidad, temperatura de color
- Composición: ángulo de cámara, encuadre, profundidad de campo
- Estilo visual: paleta de colores, atmósfera, estado de ánimo cinematográfico${styleNote}
${charSystemInstruction}
${charReferenceBlock}
Devuelve un array JSON con exactamente el mismo número de elementos que los segmentos de entrada.
Cada elemento tiene claves: "text" (copia exacta del texto de entrada), "image_prompt" (tu descripción de 200-300 palabras)${schemaInstruction}.${contextSection}`,

    french: `Vous êtes un directeur d'images IA expert spécialisé dans la création de descriptions détaillées de fotogrammes clés pour la génération image-à-vidéo.

CRITIQUE: Ces images seront utilisées comme FOTOGRAMMES CLÉS DE DÉPART pour la génération de vidéo. Chaque image doit être un moment figé qui implique du mouvement.

Pour chaque segment de texte, créez UNE description de fotogramme clé (200-300 mots):
- Sujet principal: qui ou quoi est le focus principal, pose et expression exactes
- Environnement: détails du décor, arrière-plan, éléments de premier plan
- Éclairage: source, direction, qualité, température de couleur
- Composition: angle de caméra, cadrage, profondeur de champ
- Style visuel: palette de couleurs, atmosphère, ambiance cinématographique${styleNote}
${charSystemInstruction}
${charReferenceBlock}
Retournez un tableau JSON avec exactement le même nombre d'éléments que les segments d'entrée.
Chaque élément a clés: "text" (copie exacte du texte d'entrée), "image_prompt" (votre description de 200-300 mots)${schemaInstruction}.${contextSection}`,
  };

  return prompts[language] ?? prompts.english;
}

async function generatePhase1Prompts(
  segments: Phase1Segment[],
  language: string,
  model: string,
  audioClip: boolean,
  fullStoryText: string = '',
  style: string = '',
  previousImagePrompts: string[] = [],
  characters: Record<string, string> = {},
): Promise<{ results: Array<{ text: string; image_prompt: string; characters_mentioned?: string[] }>; inputTokens: number; outputTokens: number }> {
  const systemPrompt = getPhase1SystemPrompt(language, audioClip, fullStoryText, style, previousImagePrompts, characters);
  const userMsg = `Generate keyframe image descriptions for each of the following story segments.\n\nSegments:\n${JSON.stringify(segments, null, 2)}`;

  const { content, inputTokens, outputTokens } = await callModelAPI(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
    { max_tokens: 8000, temperature: 0.6 },
    model,
  );

  const parsed = cleanAndParseJSON(content);
  if (!Array.isArray(parsed)) throw new Error('Phase 1 response is not a JSON array');

  const results = parsed
    .filter((item: any) => item && typeof item.image_prompt === 'string' && item.image_prompt.trim().length > 0)
    .map((item: any) => ({
      text: item.text || '',
      image_prompt: item.image_prompt.trim(),
      characters_mentioned: Array.isArray(item.characters_mentioned) ? item.characters_mentioned : undefined,
    }));

  if (results.length === 0) throw new Error('No valid image prompts in Phase 1 response');
  return { results, inputTokens, outputTokens };
}

// ─── Phase 2: Motion prompt generation ───────────────────────────────────────

function getPhase2SystemPrompt(
  language: string,
  audioClip: boolean,
  characters?: Record<string, string>,
  style?: string,
  fullPhase1Doc: string = '',
  previousMotionPrompts: string[] = [],
): string {
  const hasChars = characters && Object.keys(characters).length > 0;
  const charReferenceBlock = hasChars
    ? '\nCharacter Reference (character appearances are already set in keyframe images — reference them naturally in motion):\n' +
      JSON.stringify(characters, null, 2) + '\n'
    : '';
  const schemaInstruction = hasChars
    ? ', and "characters_mentioned" (a JSON array of character name strings that appear in this scene — use the exact keys from the Character Reference; empty array [] if no characters)'
    : '';
  const charSystemInstruction = hasChars
    ? '\n- When mentioning characters, use their name from the Character Reference. The matching full character descriptions will be automatically appended to your prompt after generation.'
    : '';
  const styleNote = style ? `\n- Style: ${style}` : '';
  const contextSection = fullPhase1Doc || previousMotionPrompts.length > 0 ? `

Full Phase 1 Context (all keyframe image prompts — use for visual arc and scene consistency):
${fullPhase1Doc.slice(0, 15000)}

${previousMotionPrompts.length > 0 ? `Previous Motion Prompts (use for motion and pacing consistency):
${previousMotionPrompts.slice(-5).map((p, i) => `${i + 1}. ${p.slice(0, 200)}...`).join('\n')}
` : ''}` : '';
  const prompts: Record<string, string> = {
    english: `You are an expert cinematic animator specializing in creating motion and animation descriptions for image-to-video AI generation. You receive pairs of {story text, keyframe image description} and generate precise motion prompts describing what HAPPENS in each video clip.

CRITICAL: You are describing the MOTION and ANIMATION layered on top of an existing keyframe image. The image already exists — you are describing how it comes alive.

For each {text, image_prompt} pair, write ONE motion description (100-200 words) covering:
1. Primary motion: the main action or movement in the scene
2. Camera movement: pan, tilt, push in, pull out, static, orbit — be specific
3. Character/subject animation: gestures, expressions changing, physical actions
4. Environmental animation: wind, water, light changes, particles, secondary motion
- Pacing: slow and deliberate vs. dynamic and energetic${audioClip ? '\n6. Sound atmosphere: ambient sounds woven naturally into the motion description' : ''}${styleNote}
${charSystemInstruction}
${charReferenceBlock}
RULES:
- Write ONE cohesive paragraph. No sub-headings or labeled sections.
- Focus on MOTION, not re-describing the static image.
- ⚠️ CRITICAL: The video must NOT contain any visible text, letters, words, numbers, signs, or written language.
- Make the motion feel natural and cinematically purposeful.

Output a JSON array with exactly the same number of items as input segments.
Each item must have keys: "text" (exact copy of the input segment text), "prompt" (your 100-200 word motion description)${schemaInstruction}.
Return only the JSON array, no preamble.${contextSection}`,

    german: `Sie sind ein erfahrener Filmanimator, spezialisiert auf Bewegungs- und Animationsbeschreibungen für KI-Bild-zu-Video-Generierung. Sie beschreiben, was in jedem Videoclip PASSIERT.

WICHTIG: Sie beschreiben die BEWEGUNG auf einem vorhandenen Schlüsselbild. Konzentrieren Sie sich auf Motion, nicht auf das statische Bild.

Für jedes {text, image_prompt}-Paar schreiben Sie EINE Bewegungsbeschreibung (100-200 Wörter).
${charSystemInstruction}
${charReferenceBlock}
Ausgabe als JSON-Array. Jedes Element: "text" (exakte Kopie), "prompt" (Ihre 100-200-Wort-Bewegungsbeschreibung)${schemaInstruction}.${contextSection}`,

    spanish: `Eres un animador cinematográfico experto especializado en crear descripciones de movimiento y animación para la generación de video-desde-imagen con IA. Describes lo que OCURRE en cada clip de video.

CRÍTICO: Estás describiendo el MOVIMIENTO sobre un fotograma clave existente. Concéntrate en el movimiento, no en la imagen estática.

Para cada par {text, image_prompt}, escribe UNA descripción de movimiento (100-200 palabras).
${charSystemInstruction}
${charReferenceBlock}
Devuelve un array JSON. Cada elemento: "text" (copia exacta), "prompt" (tu descripción de movimiento de 100-200 palabras)${schemaInstruction}.${contextSection}`,

    french: `Vous êtes un animateur cinématographique expert spécialisé dans la création de descriptions de mouvement et d'animation pour la génération vidéo-depuis-image avec IA. Vous décrivez ce qui SE PASSE dans chaque clip vidéo.

CRITIQUE: Vous décrivez le MOUVEMENT sur une image clé existante. Concentrez-vous sur le mouvement, pas sur l'image statique.

Pour chaque paire {text, image_prompt}, écrivez UNE description de mouvement (100-200 mots).
${charSystemInstruction}
${charReferenceBlock}
Retournez un tableau JSON. Chaque élément: "text" (copie exacte), "prompt" (votre description de 100-200 mots)${schemaInstruction}.${contextSection}`,
  };

  return prompts[language] ?? prompts.english;
}

async function generatePhase2Prompts(
  segments: Phase2Segment[],
  language: string,
  model: string,
  audioClip: boolean,
  style?: string,
  characters?: Record<string, string>,
  fullPhase1Doc: string = '',
  previousMotionPrompts: string[] = [],
): Promise<{ results: Array<{ text: string; prompt: string; characters_mentioned?: string[] }>; inputTokens: number; outputTokens: number }> {
  const systemPrompt = getPhase2SystemPrompt(language, audioClip, characters, style, fullPhase1Doc, previousMotionPrompts);
  const userMsg = `Generate motion/animation prompts for each of the following {text, image_prompt} pairs.\n\nSegments:\n${JSON.stringify(segments, null, 2)}`;

  const { content, inputTokens, outputTokens } = await callModelAPI(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
    { max_tokens: 6000, temperature: 0.5 },
    model,
  );

  const parsed = cleanAndParseJSON(content);
  if (!Array.isArray(parsed)) throw new Error('Phase 2 response is not a JSON array');

  const results = parsed
    .filter((item: any) => item && typeof item.prompt === 'string' && item.prompt.trim().length > 0)
    .map((item: any) => ({
      text: item.text || '',
      prompt: item.prompt.trim(),
      characters_mentioned: Array.isArray(item.characters_mentioned) ? item.characters_mentioned : undefined,
    }));

  if (results.length === 0) throw new Error('No valid motion prompts in Phase 2 response');
  return { results, inputTokens, outputTokens };
}

// ─── serve ────────────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const body: RequestBody = await req.json();
    const {
      itv,
      task_id,
      group_id,
      tab = 1,
      variant = 1,
      language = 'english',
      model = 'sonnet',
      audio_clip = false,
      style = '',
      text_part = '1',
      batch_segments,
      phase2_segments,
      characters,
    } = body;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!task_id || !uuidRegex.test(task_id)) return new Response(JSON.stringify({ error: 'Missing or invalid task_id' }), { status: 400, headers: responseHeaders });
    if (!group_id || !uuidRegex.test(group_id)) return new Response(JSON.stringify({ error: 'Missing or invalid group_id' }), { status: 400, headers: responseHeaders });

    const validatedModel = ['deepseek', 'sonnet', 'opus'].includes(model) ? model : 'sonnet';
    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language) ? language : 'english';
    const partNumber = parseInt(text_part, 10) || 1;

    if (!itv) {
      // ── Phase 1: Generate keyframe image prompts ─────────────────────────
      if (!batch_segments || !Array.isArray(batch_segments) || batch_segments.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing or empty batch_segments for Phase 1' }), { status: 400, headers: responseHeaders });
      }
      for (const seg of batch_segments) {
        if (typeof seg.text !== 'string' || seg.text.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Invalid segment: empty text' }), { status: 400, headers: responseHeaders });
        }
      }

      console.log(`Phase 1: generating ${batch_segments.length} keyframe image prompts (model=${validatedModel}, part=${partNumber})`);

      // Fetch story context for this part
      const phase1Context = await fetchITVContext(group_id, partNumber, tab, false);
      const fullStoryText = phase1Context?.full_story_text ?? '';
      const effectiveStyle = phase1Context?.style_description ?? style;

      // Fetch this task's batch_number to query only earlier batches
      const { data: taskMeta } = await supabase
        .from('ITV_prompt_tasks')
        .select('batch_number, user_id')
        .eq('id', task_id)
        .single();

      // Fetch last 5 completed Phase 1 batches for visual consistency
      let previousImagePrompts: string[] = [];
      const { data: completedPhase1 } = await supabase
        .from('ITV_prompt_tasks')
        .select('batch_output')
        .eq('group_id', group_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('itv', false)
        .eq('status', 'completed')
        .lt('batch_number', taskMeta?.batch_number ?? 0)
        .order('batch_number', { ascending: false })
        .limit(5);

      if (completedPhase1) {
        const ordered = [...completedPhase1].reverse();
        for (const ct of ordered) {
          try {
            const out = JSON.parse(ct.batch_output);
            if (Array.isArray(out)) previousImagePrompts.push(...out.map((r: any) => r.image_prompt ?? '').filter(Boolean));
          } catch (_) { /* skip malformed */ }
        }
        console.log(`Loaded ${previousImagePrompts.length} previous Phase 1 image prompts for context`);
      }

      const { results: rawPhase1Results, inputTokens, outputTokens } = await generatePhase1Prompts(
        batch_segments,
        validatedLanguage,
        validatedModel,
        audio_clip,
        fullStoryText,
        effectiveStyle,
        previousImagePrompts,
        characters ?? {},
      );

      // Selectively append only mentioned character descriptions (with 3-way fallback)
      const phase1NoTextWarning = '\n\n⚠️ CRITICAL REQUIREMENT: This image must NOT contain any text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, speech bubbles, or any readable characters whatsoever.';
      const phase1AllChars = characters ?? {};
      const phase1HasChars = Object.keys(phase1AllChars).length > 0;
      const phase1CustomCharsInStory: boolean = phase1Context?.custom_chars_in_story ?? true;

      const results = rawPhase1Results.map(item => {
        let charSuffix = phase1NoTextWarning;
        if (phase1HasChars) {
          const filtered = filterCharacterDescriptions(phase1AllChars, item.characters_mentioned);
          if (Object.keys(filtered).length > 0) {
            // Case 1: Found matching characters for this prompt
            charSuffix = `\nCharacter Descriptions:\n${formatCharacterDescriptions(filtered)}${phase1NoTextWarning}`;
          } else if (!phase1CustomCharsInStory) {
            // Case 2: No match AND custom char names not in story → append ALL as fallback
            charSuffix = `\nCharacter Descriptions:\n${formatCharacterDescriptions(phase1AllChars)}${phase1NoTextWarning}`;
          }
          // Case 3: No match but names ARE in story → just no-text warning (default)
        }
        return {
          text: item.text,
          image_prompt: (style ? `${style}. ${item.image_prompt}` : item.image_prompt) + charSuffix,
        };
      });

      const userIdForBilling: string = (taskMeta?.user_id as string | undefined) ?? (auth.userId || '');
      const isLegacy = await getIsLegacyPlan(userIdForBilling);
      const tokenMultiplier = llmMultiplier(isLegacy, validatedModel);
      const adjustedTokens = Math.round((inputTokens + outputTokens) * tokenMultiplier);

      return new Response(JSON.stringify({
        output: results,      // [{text, image_prompt}]
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens: adjustedTokens,
        phase: 1,
        model: validatedModel,
      }), { status: 200, headers: responseHeaders });

    } else {
      // ── Phase 2: Generate motion/animation prompts ───────────────────────
      if (!phase2_segments || !Array.isArray(phase2_segments) || phase2_segments.length === 0) {
        return new Response(JSON.stringify({ error: 'Missing or empty phase2_segments for Phase 2' }), { status: 400, headers: responseHeaders });
      }
      for (const seg of phase2_segments) {
        if (typeof seg.text !== 'string' || seg.text.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Invalid segment: empty text' }), { status: 400, headers: responseHeaders });
        }
        if (typeof seg.image_prompt !== 'string' || seg.image_prompt.trim().length === 0) {
          return new Response(JSON.stringify({ error: 'Invalid segment: empty image_prompt' }), { status: 400, headers: responseHeaders });
        }
      }

      console.log(`Phase 2: generating ${phase2_segments.length} motion prompts (model=${validatedModel})`);

      // Fetch compiled Phase 1 document as context for motion generation
      const phase2Context = await fetchITVContext(group_id, 1, tab, true);
      const fullPhase1Doc = phase2Context?.full_story_text ?? '';
      const effectiveStyle2 = phase2Context?.style_description ?? style;

      // Fetch this task's batch_number
      const { data: taskMeta2 } = await supabase
        .from('ITV_prompt_tasks')
        .select('batch_number, user_id')
        .eq('id', task_id)
        .single();

      // Fetch last 5 completed Phase 2 batches for motion consistency
      let previousMotionPrompts: string[] = [];
      const { data: completedPhase2 } = await supabase
        .from('ITV_prompt_tasks')
        .select('batch_output')
        .eq('group_id', group_id)
        .eq('tab', tab)
        .eq('variant', variant)
        .eq('itv', true)
        .eq('status', 'completed')
        .lt('batch_number', taskMeta2?.batch_number ?? 0)
        .order('batch_number', { ascending: false })
        .limit(5);

      if (completedPhase2) {
        const ordered = [...completedPhase2].reverse();
        for (const ct of ordered) {
          try {
            const out = JSON.parse(ct.batch_output);
            if (Array.isArray(out)) previousMotionPrompts.push(...out.map((r: any) => r.prompt ?? '').filter(Boolean));
          } catch (_) { /* skip malformed */ }
        }
        console.log(`Loaded ${previousMotionPrompts.length} previous Phase 2 motion prompts for context`);
      }

      const { results: rawPhase2Results, inputTokens, outputTokens } = await generatePhase2Prompts(
        phase2_segments,
        validatedLanguage,
        validatedModel,
        audio_clip,
        effectiveStyle2,
        characters,
        fullPhase1Doc,
        previousMotionPrompts,
      );

      // Selectively append only mentioned character descriptions (with 3-way fallback)
      const phase2NoTextWarning = '\n\n⚠️ CRITICAL REQUIREMENT: This video must NOT contain any visible text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, subtitles, or any readable characters whatsoever in the video content.';
      const phase2AllChars = characters ?? {};
      const phase2HasChars = Object.keys(phase2AllChars).length > 0;
      const phase2CustomCharsInStory: boolean = phase2Context?.custom_chars_in_story ?? true;

      const results = rawPhase2Results.map(item => {
        let charSuffix = phase2NoTextWarning;
        if (phase2HasChars) {
          const filtered = filterCharacterDescriptions(phase2AllChars, item.characters_mentioned);
          if (Object.keys(filtered).length > 0) {
            // Case 1: Found matching characters for this prompt
            charSuffix = `\nCharacter Descriptions:\n${formatCharacterDescriptions(filtered)}${phase2NoTextWarning}`;
          } else if (!phase2CustomCharsInStory) {
            // Case 2: No match AND custom char names not in story → append ALL as fallback
            charSuffix = `\nCharacter Descriptions:\n${formatCharacterDescriptions(phase2AllChars)}${phase2NoTextWarning}`;
          }
          // Case 3: No match but names ARE in story → just no-text warning (default)
        }
        return {
          text: item.text,
          prompt: item.prompt + charSuffix,
        };
      });

      const userIdForBilling2: string = (taskMeta2?.user_id as string | undefined) ?? (auth.userId || '');
      const isLegacy2 = await getIsLegacyPlan(userIdForBilling2);
      const tokenMultiplier = llmMultiplier(isLegacy2, validatedModel);
      const adjustedTokens = Math.round((inputTokens + outputTokens) * tokenMultiplier);

      return new Response(JSON.stringify({
        output: results,      // [{text, prompt}]
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tokens: adjustedTokens,
        phase: 2,
        model: validatedModel,
      }), { status: 200, headers: responseHeaders });
    }

  } catch (error: any) {
    console.error(`Error in generate-ITV-prompt: ${error.message}`);
    await logError('Error in generate-ITV-prompt', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { status: 500, headers: responseHeaders });
  }
});
