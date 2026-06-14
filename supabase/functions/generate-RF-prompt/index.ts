import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getIsLegacyPlan, llmMultiplier } from '../_shared/tokenCosts.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { clampRFClipDuration, RF_CLIP_DURATION_MIN, RF_CLIP_DURATION_MAX } from '../_shared/rfClipDuration.ts';

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
  deepseek: {
    apiKey: deepseekApiKey,
    baseURL: 'https://api.deepseek.com',
    tokenMultiplier: 1.0,
  },
  sonnet: {
    apiKey: anthropicApiKey,
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 11.0,
  },
  opus: {
    apiKey: anthropicApiKey,
    baseURL: 'https://api.anthropic.com',
    tokenMultiplier: 19.0,
  },
};

// ─── Text normalisation ────────────────────────────────────────────────────────

function normalizeText(text: string): string {
  if (!text) return text;
  // Strip SSML break tags (well-formed, malformed, and incomplete)
  text = text.replace(/<break\b[^>]*?\/?>/gi, '');
  text = text.replace(/<break\b[^>]*$/gm, '');
  text = text.replace(/^\s*["'\u2018\u2019\u201C\u201D]?\d+ms["'\u2018\u2019\u201C\u201D]?\s*\/?>/gm, '');

  let normalized = text
    .replace(/\uFFFD/g, "'")
    .replace(/â€™/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€\u009D/g, '"')
    .replace(/â€"/g, '—')
    .replace(/â€"/g, '–')
    .replace(/â€¦/g, '…')
    .replace(/Ã¢â‚¬â„¢/g, "'")
    .replace(/Ã¢â‚¬Å"/g, '"')
    .replace(/Ã¢â‚¬Â/g, '"')
    .replace(/Ã¢â‚¬â€œ/g, '—');

  normalized = normalized
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u2039\u203A]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/[\u2010\u2011\u2012]/g, '-')
    .replace(/\u2015/g, '—')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ');

  normalized = normalized
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return normalized;
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

function getTokenMultiplier(model: string): number {
  return MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]?.tokenMultiplier ?? 1.0;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface RFSegment {
  text: string;
  start: number;
  video_duration: number;
}

interface RequestBody {
  batch_segments: RFSegment[];
  text_part: string;          // Part-number reference (e.g. "1")
  settings: {
    style: string;
    useCharacterDescriptions: boolean;
    video_model: string;
    video_duration: number;
  };
  use_character_descriptions: boolean;
  characters?: Record<string, string>;
  language?: string;
  model?: string;
  task_id: string;
  group_id: string;
  tab?: number;
  variant?: number;
  audio_clip?: boolean;
}

interface PromptResult {
  text: string;
  prompt: string;
  video_duration: number;
  characters_mentioned?: string[];
}

// ─── Input validation ─────────────────────────────────────────────────────────

function validateInputs(data: RequestBody): string | null {
  if (!data.batch_segments || !Array.isArray(data.batch_segments) || data.batch_segments.length === 0)
    return 'Missing or empty batch_segments';
  if (typeof data.text_part !== 'string' || data.text_part.length === 0)
    return 'Missing or empty text_part';
  if (!data.settings || typeof data.settings !== 'object')
    return 'Missing or invalid settings';
  if (typeof data.use_character_descriptions !== 'boolean')
    return 'Missing or invalid use_character_descriptions';
  if (data.use_character_descriptions && (!data.characters || typeof data.characters !== 'object'))
    return 'Missing or invalid characters when use_character_descriptions is true';
  for (const seg of data.batch_segments) {
    if (typeof seg.text !== 'string' || seg.text.length === 0) return 'Invalid segment: empty text';
    if (typeof seg.start !== 'number' || seg.start < 0) return 'Invalid segment: invalid start';
    if (typeof seg.video_duration !== 'number' || seg.video_duration <= 0) return 'Invalid segment: invalid video_duration';
  }
  return null;
}

// ─── Model client ─────────────────────────────────────────────────────────────

function createModelClient(model: string) {
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  if (!config) throw new Error(`Unsupported model: ${model}`);
  if (!config.apiKey) throw new Error(`API key not set for model: ${model}`);
  return config;
}

async function callModelAPI(config: any, messages: any[], options: any, model: string) {
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
      choices: [{ message: { content } }],
      usage: {
        prompt_tokens: estimateTokens(messages.map((m: any) => m.content).join('')),
        completion_tokens: estimateTokens(content),
      },
    };
  } else {
    // Anthropic
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
      choices: [{ message: { content: result.content[0].text } }],
      usage: {
        prompt_tokens: result.usage?.input_tokens ?? 0,
        completion_tokens: result.usage?.output_tokens ?? 0,
      },
    };
  }
}

// ─── JSON cleaning ────────────────────────────────────────────────────────────

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

// ─── Character formatting ─────────────────────────────────────────────────────

function formatCharacterDescriptions(characters: Record<string, string> | null | undefined): string {
  if (!characters || Object.keys(characters).length === 0) {
    return '\n\n⚠️ CRITICAL REQUIREMENT: This video must NOT contain any visible text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, subtitles, or any readable characters whatsoever.';
  }
  const charLines = Object.entries(characters).map(([name, desc]) => `  "${name}": "${desc}"`);
  return '\n\nCharacter Descriptions:\n{\n' + charLines.join(',\n') + '\n}' +
    '\n\n⚠️ CRITICAL REQUIREMENT: This video must NOT contain any visible text, letters, words, numbers, signs, symbols, or written language of any kind. Do not include labels, captions, subtitles, or any readable characters whatsoever.';
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

// ─── Context fetching ─────────────────────────────────────────────────────────

async function fetchTTVContext(groupId: string, partNumber: number = 1, tab: number = 1) {
  const { data, error } = await supabase
    .from('RF_prompt_context')
    .select('*')
    .eq('group_id', groupId)
    .eq('part_number', partNumber)
    .eq('tab', tab)
    .single();

  if (error || !data) {
    // Fallback: try without tab filter for backward compatibility
    console.log(`No TTV context found for group ${groupId}, part ${partNumber}, tab ${tab} — trying fallback without tab filter`);
    const { data: fallback } = await supabase
      .from('RF_prompt_context')
      .select('*')
      .eq('group_id', groupId)
      .eq('part_number', partNumber)
      .single();
    if (fallback) {
      console.log(`Fallback TTV context found for part ${partNumber}: ${fallback.full_story_text?.length ?? 0} chars`);
      return fallback;
    }
    console.log(`No TTV context found at all for group ${groupId}, part ${partNumber}`);
    return null;
  }
  console.log(`Fetched TTV context part ${partNumber} tab ${tab}: ${data.full_story_text?.length ?? 0} chars`);
  return data;
}

// ─── Master Prompt helpers ───────────────────────────────────────────────────

function buildVisualGuidelines(masterPrompt: Record<string, any> | null | undefined): string {
  if (!masterPrompt) return '';
  const lines: string[] = [];
  if (masterPrompt.texture)       lines.push(`- Texture: ${masterPrompt.texture}`);
  if (masterPrompt.color_palette) lines.push(`- Color palette: ${masterPrompt.color_palette}`);
  if (masterPrompt.color_rules)   lines.push(`- Color rules / visual motifs: ${masterPrompt.color_rules}`);
  if (masterPrompt.atmosphere)    lines.push(`- Atmosphere: ${masterPrompt.atmosphere}`);
  if (masterPrompt.era)           lines.push(`- Era: ${masterPrompt.era}`);
  if (masterPrompt.setting)       lines.push(`- Setting: ${masterPrompt.setting}`);
  if (masterPrompt.composition)   lines.push(`- Cinematography: ${masterPrompt.composition}`);
  return lines.length > 0 ? `\nVisual guidelines:\n${lines.join('\n')}` : '';
}

// ─── System prompt ────────────────────────────────────────────────────────────

function getSystemPrompt(
  language: string,
  style: string,
  characters: Record<string, string>,
  environmentOnlyMode: boolean,
  fullStoryContext: string,
  previousPrompts: string[],
  masterPromptData?: Record<string, any> | null,
  audioClip: boolean = false,
  totalAudioSeconds: number = 0,
): string {
  // Master Prompt overrides: characters and environment_only
  const effectiveCharacters: Record<string, string> =
    (masterPromptData?.characters && Object.keys(masterPromptData.characters).length > 0)
      ? masterPromptData.characters
      : (characters ?? {});

  const effectiveEnvironmentOnly: boolean =
    masterPromptData?.environment_only === true ? true : environmentOnlyMode;

  // Use verbatim style string from master prompt; other fields become structured visual guidelines
  const effectiveStyle = masterPromptData?.style || style;
  const visualGuidelinesBlock = buildVisualGuidelines(masterPromptData);

  const hasChars = effectiveCharacters && Object.keys(effectiveCharacters).length > 0;
  const charReferenceBlock = hasChars
    ? '\nCharacter Reference (use ONLY these names when characters appear):\n' +
      JSON.stringify(effectiveCharacters, null, 2) + '\n'
    : '';
  const schemaInstruction = hasChars
    ? ', and "characters_mentioned" (a JSON array of character name strings that appear in this scene — use the exact keys from the Character Reference; empty array [] if no characters)'
    : '';
  const charSystemInstruction = hasChars
    ? '\n- When mentioning characters, use their name from the Character Reference. The matching full character descriptions will be automatically appended to your prompt after generation.'
    : '';

  const characterDescriptions = Object.entries(effectiveCharacters)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join('\n');

  const contextSection = `
Full Story Context (for scene continuity and character consistency):
${fullStoryContext.slice(0, 15000)}

${previousPrompts.length > 0 ? `Previous Video Prompts (use for visual consistency):
${previousPrompts.slice(-5).map((p, i) => `${i + 1}. ${p.slice(0, 200)}...`).join('\n')}
` : ''}`;

  const audioDurationBlock = totalAudioSeconds > 0
    ? `\nTotal narration audio: ${Math.round(totalAudioSeconds)} seconds. For each segment assign "video_duration" (integer ${RF_CLIP_DURATION_MIN}–${RF_CLIP_DURATION_MAX}) — how long the stock clip should be. Denser or longer segments get longer clips; quick transitions get shorter clips. Across the full story, durations should sum to roughly ${Math.round(totalAudioSeconds)}s.\n`
    : '';

  const prompts: Record<string, string> = {
    english: `You help find real stock footage on Coverr and Pexels. For each story segment, output a short stock-video SEARCH QUERY (not a cinematic AI prompt).

CRITICAL: Exactly ONE search query per segment. Do NOT split or merge segments.
${audioDurationBlock}
Rules for "prompt" (the search query field):
- 3–12 words, concrete and visual (subjects, actions, setting, mood)
- Suitable for stock video sites (e.g. "woman walking city street rain", "aerial forest morning mist")
- No quotes around the whole query; no instructions to the video API
- Style context: ${effectiveStyle}${visualGuidelinesBlock}
${effectiveEnvironmentOnly ? '- Prefer environment/landscape shots with minimal people.' : ''}

Output a JSON array with exactly the same number of items as input segments.
Each item: "text" (exact copy of segment text), "prompt" (stock search query string), "video_duration" (integer ${RF_CLIP_DURATION_MIN}–${RF_CLIP_DURATION_MAX})${schemaInstruction}.
Return only the JSON array.

${contextSection}`,

    german: `Sie sind ein erfahrener Filmregisseur. Erstellen Sie prägnante 150-250-Wort-Videoprompts für jedes Textsegment.

WICHTIG: Erstellen Sie genau EINEN Videoprompt pro Textsegment. Segmente niemals aufteilen oder zusammenführen.

Schreiben Sie für jedes Segment eine einzelne fließende filmische Beschreibung in dieser Reihenfolge:
1. Erzählaktion: was passiert, wer anwesend ist, was sie tun — der spezifische Geschichtsmoment
2. Kameraführung und -bewegung (z.B. langsames Heranzoomen auf eine Nahaufnahme, weite Verfolgungsaufnahme)
3. Beleuchtung und Atmosphäre (z.B. hartes Neonlicht, goldene Seitenlicht bei Sonnenuntergang)
4. Stil: ${effectiveStyle}${visualGuidelinesBlock}
${audioClip ? `5. Klangatmosphäre: Eine natürliche Beschreibung des Umgebungsklangs und Sounddesigns direkt in den Absatz einweben. An die Cliplänge anpassen: 4s → ein präziser Klanghinweis; 6–8s → 2–3 überlagerte Klänge; 10s+ → eine sich entwickelnde Klanglandschaft. KEINE Labels wie 'Audio:' oder 'Sounddesign:' — es muss als Teil der filmischen Prosa gelesen werden.
` : ''}- Körpersprache und emotionaler Ausdruck der Charaktere — Charaktere nur beim Namen nennen
${effectiveEnvironmentOnly ? '- NUR-UMGEBUNGS-MODUS: Fokus auf den Ort und die Atmosphäre als Hauptmotiv. Minimaler Charakterfokus — keine detaillierten Gesichter.' : ''}
${charSystemInstruction}
${charReferenceBlock}
REGELN:
- Ein zusammenhängender Absatz pro Prompt. Keine Unterüberschriften, keine beschrifteten Abschnitte.
- Keine 'Kameraführung:', 'Audiodesign:', 'Beleuchtung:', 'Übergangsnotiz:' oder ähnliche Labels.
- Sprache visuell und bewegungsorientiert halten.
${audioClip ? `- Die Klangatmosphäre wird inline in den Absatz eingebettet — niemals als separater Abschnitt oder mit einer Bezeichnung.\n` : ''}- ⚠️ KRITISCH: Das Video darf keinen sichtbaren Text, Buchstaben, Wörter, Zahlen, Zeichen oder Schriftsprache enthalten.

Gib ein JSON-Array zurück mit exakt der gleichen Anzahl an Elementen wie Eingabesegmente.
Jedes Element muss Schlüssel haben: "text" (exakte Kopie des Eingabesegmenttexts), "prompt" (deine 150-250-Wort-Filmbeschreibung)${schemaInstruction}.
Nur das JSON-Array zurückgeben, keine Einleitung.

${contextSection}`,

    spanish: `Eres un director cinematográfico experto. Genera prompts de video concisos de 150-250 palabras para cada segmento de texto.

CRÍTICO: Crea exactamente UN prompt de video por segmento de texto. NO dividas ni combines segmentos.

Para cada segmento, escribe una única descripción cinematográfica fluida en este orden:
1. Acción narrativa: qué está ocurriendo, quién está presente, qué están haciendo — el momento específico de la historia
2. Encuadre y movimiento de cámara (ej. lento acercamiento en plano medio-cercano, toma de seguimiento amplia)
3. Iluminación y atmósfera (ej. fluorescentes duros cenitales, luz lateral dorada al atardecer)
4. Estilo: ${effectiveStyle}${visualGuidelinesBlock}
${audioClip ? `5. Atmósfera sonora: teje una descripción natural del sonido ambiental y diseño de sonido directamente en el párrafo. Escalar según la duración del clip: 4s → una clave de sonido precisa; 6–8s → 2–3 sonidos superpuestos; 10s+ → un paisaje sonoro evolutivo. NO usar etiquetas como 'Audio:' o 'Diseño de Sonido:' — debe leerse como parte de la prosa cinemática.
` : ''}- Lenguaje corporal y expresión emocional de los personajes — referirse a los personajes solo por nombre
${effectiveEnvironmentOnly ? '- MODO SOLO-ENTORNO: Enfoque en la ubicación y la atmósfera como sujeto principal. Mínimo enfoque en personajes — no mostrar rostros en detalle.' : ''}
${charSystemInstruction}
${charReferenceBlock}
REGLAS:
- Escribe UN párrafo cohesivo por prompt. Sin subtítulos, sin secciones etiquetadas.
- Sin 'Cinematografía:', 'Diseño de Audio:', 'Iluminación:', 'Nota de Transición:' ni etiquetas similares.
- Mantener el lenguaje visual y orientado al movimiento.
${audioClip ? `- La atmósfera sonora se describe en línea dentro del párrafo — nunca como sección separada ni con ninguna etiqueta.\n` : ''}- ⚠️ CRÍTICO: El video NO debe contener ningún texto visible, letras, palabras, números, signos o lenguaje escrito.

Devuelve un array JSON con exactamente el mismo número de elementos que los segmentos de entrada.
Cada elemento debe tener claves: "text" (copia exacta del texto del segmento de entrada), "prompt" (tu descripción cinematográfica de 150-250 palabras)${schemaInstruction}.
Devuelve solo el array JSON, sin preámbulo.

${contextSection}`,

    french: `Vous êtes un réalisateur cinématographique expert. Générez des prompts vidéo concis de 150-250 mots pour chaque segment de texte.

CRITIQUE : Créez exactement UN prompt vidéo par segment de texte. Ne divisez PAS et ne fusionnez PAS les segments.

Pour chaque segment, rédigez une seule description cinématographique fluide dans cet ordre :
1. Action narrative : ce qui se passe, qui est présent, ce qu'ils font — le moment spécifique de l'histoire
2. Le cadrage et le mouvement de caméra (ex. lente poussée sur un plan rapproché moyen, plan de suivi large)
3. L'éclairage et l'atmosphère (ex. néons durs en plongée, lumière latérale dorée au coucher du soleil)
4. Style : ${effectiveStyle}${visualGuidelinesBlock}
${audioClip ? `5. Atmosphère sonore : tissez une description naturelle du son ambiant et du design sonore directement dans le paragraphe. Adapter à la durée du clip : 4s → un cue sonore précis ; 6–8s → 2–3 sons superposés ; 10s+ → un paysage sonore évolutif. PAS de labels comme « Audio : » ou « Conception Sonore : » — cela doit se lire comme faisant partie de la prose cinématographique.
` : ''}- Le langage corporel et l'expression émotionnelle des personnages — se référer aux personnages uniquement par leur nom
${effectiveEnvironmentOnly ? "- MODE ENVIRONNEMENT UNIQUEMENT : Focus sur le lieu et l'atmosphère comme sujet principal. Focalisation minimale sur les personnages — ne pas montrer les visages en détail." : ''}
${charSystemInstruction}
${charReferenceBlock}
RÈGLES :
- Rédigez UN paragraphe cohérent par prompt. Pas de sous-titres, pas de sections étiquetées.
- Pas de 'Cinématographie :', 'Conception Audio :', 'Éclairage :', 'Note de Transition :' ni d'étiquettes similaires.
- Garder le langage visuel et orienté vers le mouvement.
${audioClip ? "- L'atmosphère sonore est décrite en ligne dans le paragraphe — jamais comme section séparée ni avec aucune étiquette.\n" : ''}- ⚠️ CRITIQUE : La vidéo ne doit PAS contenir de texte visible, de lettres, de mots, de chiffres, de signes ou de langage écrit.

Retournez un tableau JSON avec exactement le même nombre d'éléments que les segments d'entrée.
Chaque élément doit avoir clés : "text" (copie exacte du texte du segment d'entrée), "prompt" (votre description cinématographique de 150-250 mots)${schemaInstruction}.
Retournez uniquement le tableau JSON, sans préambule.

${contextSection}`,
  };

  return prompts[language as keyof typeof prompts] ?? prompts.english;
}

// ─── serve ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
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

    const { batch_segments, text_part, settings, use_character_descriptions, characters = {}, language, model, task_id, group_id, tab = 1, variant = 1, audio_clip = false } = payload;

    const partNumber = parseInt(text_part, 10);
    const contextPartNumber = !isNaN(partNumber) && partNumber > 0 ? partNumber : 1;

    // Fetch TTV context (scoped by tab)
    const fullContext = await fetchTTVContext(group_id, contextPartNumber, tab);

    // Fetch task batch number for ordering previous prompts
    const { data: taskData } = await supabase
      .from('RF_prompt_tasks')
      .select('batch_number, user_id')
      .eq('id', task_id)
      .single();

    // Fetch previous completed prompts for context/consistency (scoped to same tab+variant).
    // Limit to last 5 batches — getSystemPrompt only ever uses slice(-5) and fetching all
    // batches for long stories can cause timeout on the Supabase connection.
    let previousPrompts: string[] = [];
    const { data: completedTasks } = await supabase
      .from('RF_prompt_tasks')
      .select('batch_output')
      .eq('group_id', group_id)
      .eq('tab', tab)
      .eq('variant', variant)
      .eq('status', 'completed')
      .lt('batch_number', taskData?.batch_number ?? 0)
      .order('batch_number', { ascending: false })
      .limit(5);

    if (completedTasks) {
      // Reverse to oldest→newest order so slice(-5) is consistent
      const orderedTasks = [...completedTasks].reverse();
      for (const ct of orderedTasks) {
        try {
          const output = JSON.parse(ct.batch_output);
          if (Array.isArray(output)) {
            previousPrompts.push(...output.map((item: any) => item.prompt ?? '').filter(Boolean));
          }
        } catch (_) { /* skip malformed */ }
      }
      console.log(`Loaded ${previousPrompts.length} previous TTV prompts for context (tab=${tab}, variant=${variant})`);
    }

    // Normalise segment text
    const normalizedSegments = batch_segments.map(seg => ({ ...seg, text: normalizeText(seg.text) }));

    const validatedModel = 'sonnet';
    const validatedLanguage = ['english', 'german', 'spanish', 'french'].includes(language ?? '') ? language! : 'english';

    const totalAudioSeconds = Number(fullContext?.total_audio_duration) > 0
      ? Number(fullContext.total_audio_duration)
      : 0;

    const systemPrompt = getSystemPrompt(
      validatedLanguage,
      fullContext?.style_description ?? settings.style,
      fullContext?.character_descriptions ?? characters,
      fullContext?.environment_only_mode ?? false,
      fullContext?.full_story_text ?? '',
      previousPrompts,
      fullContext?.master_prompt_data ?? null,
      audio_clip,
      totalAudioSeconds,
    );

    let userPrompt = `Process these ${normalizedSegments.length} segment(s). For EACH segment, copy "text" EXACTLY, generate ONE stock-footage search query in "prompt", and assign "video_duration" (${RF_CLIP_DURATION_MIN}–${RF_CLIP_DURATION_MAX} seconds):\n\n`;
    if (totalAudioSeconds > 0) {
      userPrompt += `Total narration audio: ${Math.round(totalAudioSeconds)} seconds.\n\n`;
    }

    const mapResultDuration = (raw: unknown, fallback: number): number =>
      clampRFClipDuration(typeof raw === 'number' && raw > 0 ? raw : fallback);

    normalizedSegments.forEach((seg, idx) => {
      userPrompt += `Segment ${idx + 1} (${seg.text.length} chars, ~${seg.video_duration}s clip):\nText: ${seg.text}\n\n`;
    });

    const config = createModelClient(validatedModel);
    const isAnthropic = validatedModel === 'sonnet' || validatedModel === 'opus';
    const apiOptions = { max_tokens: isAnthropic ? 16000 : 8000, temperature: isAnthropic ? 0.4 : 0.6 };

    let response = await callModelAPI(config, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], apiOptions, validatedModel);

    let jsonOutput = response.choices[0].message.content.trim();
    console.log(`Raw ${validatedModel} response (first 500 chars):`, jsonOutput.substring(0, 500));

    let results: PromptResult[] = [];
    let retryAttempt = 0;
    const maxRetries = 2;

    while (retryAttempt <= maxRetries) {
      try {
        const parsed = cleanAndParseJSON(jsonOutput);
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Results is not a non-empty array');

        if (parsed.length !== normalizedSegments.length) {
          if (parsed.length > normalizedSegments.length && retryAttempt < maxRetries) {
            retryAttempt++;
            console.log(`Count mismatch: got ${parsed.length}, expected ${normalizedSegments.length}. Retry ${retryAttempt}`);
            const correctivePrompt = `STOP! You created ${parsed.length} prompts for ${normalizedSegments.length} segment(s).
This is WRONG. You MUST produce exactly ${normalizedSegments.length} prompt(s) — one per segment.
${normalizedSegments.length === 1 ? 'Merge all your prompts into ONE single 150-250 word paragraph.' : `Map each of the ${normalizedSegments.length} segments to exactly ONE prompt.`}
Return EXACTLY ${normalizedSegments.length} result(s) in the JSON array.`;

            response = await callModelAPI(config, [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: jsonOutput },
              { role: 'user', content: correctivePrompt },
            ], apiOptions, validatedModel);
            jsonOutput = response.choices[0].message.content.trim();
            continue;
          }

          // Fallback: force align
          if (normalizedSegments.length === 1) {
            const combined = parsed.map((r: any) => r.prompt ?? '').join(' ');
            // Merge characters_mentioned from all parsed results
            const allMentioned = parsed.flatMap((r: any) => Array.isArray(r.characters_mentioned) ? r.characters_mentioned : []);
            const uniqueMentioned = [...new Set(allMentioned)];
            results = [{ text: normalizedSegments[0].text, prompt: combined.substring(0, 600), video_duration: mapResultDuration(parsed[0]?.video_duration, normalizedSegments[0].video_duration), characters_mentioned: uniqueMentioned.length > 0 ? uniqueMentioned : undefined }];
          } else {
            results = normalizedSegments.map((seg, i) => ({
              text: seg.text,
              prompt: parsed[i]?.prompt ?? '',
              video_duration: mapResultDuration(parsed[i]?.video_duration, seg.video_duration),
              characters_mentioned: Array.isArray(parsed[i]?.characters_mentioned) ? parsed[i].characters_mentioned : undefined,
            }));
          }
          break;
        }

        for (const r of parsed) {
          if (!r.text || !r.prompt) throw new Error('Invalid result: missing text or prompt');
        }

        results = parsed.map((r: any, i: number) => ({
          text: r.text ?? normalizedSegments[i].text,
          prompt: r.prompt ?? '',
          video_duration: mapResultDuration(r.video_duration, normalizedSegments[i]?.video_duration ?? settings.video_duration),
          characters_mentioned: Array.isArray(r.characters_mentioned) ? r.characters_mentioned : undefined,
        }));
        break;
      } catch (err: any) {
        if (retryAttempt >= maxRetries) {
          console.error(`Failed to parse response after ${maxRetries} retries: ${err.message}`);
          await logError('Failed to parse TTV prompt response', err);
          throw new Error(`Failed to parse response: ${err.message}`);
        }
        retryAttempt++;
      }
    }

    // Prepend style and selectively append character descriptions
    const masterPromptForBlock = (fullContext?.master_prompt_data ?? null) as Record<string, any> | null;
    const styleForBlock: string = masterPromptForBlock?.style || fullContext?.style_description || settings.style || '';
    const visualGuidelinesForBlock = buildVisualGuidelines(masterPromptForBlock);
    const styleBlock = styleForBlock + visualGuidelinesForBlock;

    // Determine effective characters (master prompt overrides context)
    const effectiveCharsForPost: Record<string, string> =
      (masterPromptForBlock?.characters && Object.keys(masterPromptForBlock.characters).length > 0)
        ? masterPromptForBlock.characters
        : (fullContext?.character_descriptions ?? characters ?? {});

    // Read custom_chars_in_story flag for 3-way fallback (mirrors Python logic)
    const customCharsInStory: boolean = fullContext?.custom_chars_in_story ?? true;

    if (use_character_descriptions && Object.keys(effectiveCharsForPost).length > 0) {
      console.log(`Selectively appending character descriptions to ${results.length} prompts (customCharsInStory=${customCharsInStory})`);
      results = results.map(r => {
        const mentioned = r.characters_mentioned;
        const filtered = filterCharacterDescriptions(effectiveCharsForPost, mentioned);
        let charBlock: string;
        if (Object.keys(filtered).length > 0) {
          // Case 1: Found matching characters for this prompt
          charBlock = formatCharacterDescriptions(filtered);
        } else if (!customCharsInStory) {
          // Case 2: No match AND custom char names not in story → append ALL as fallback
          charBlock = formatCharacterDescriptions(effectiveCharsForPost);
        } else {
          // Case 3: No match but names ARE in story → just no-text warning
          charBlock = formatCharacterDescriptions(null);
        }
        const { characters_mentioned, ...rest } = r;
        return {
          ...rest,
          prompt: styleBlock + '. ' + rest.prompt + (charBlock || ''),
        };
      });
    } else {
      const noCharWarning = formatCharacterDescriptions(null);
      results = results.map(r => {
        const { characters_mentioned, ...rest } = r;
        return {
          ...rest,
          prompt: styleBlock + '. ' + rest.prompt + noCharWarning,
        };
      });
    }

    let totalInputTokens = response.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt);
    let totalOutputTokens = response.usage?.completion_tokens ?? estimateTokens(jsonOutput);
    const userIdForBilling: string = (taskData?.user_id as string | undefined) ?? (auth.userId || '');
    const isLegacy = await getIsLegacyPlan(userIdForBilling);
    const multiplier = llmMultiplier(isLegacy, validatedModel);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`generate-RF-prompt runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(JSON.stringify({
      results,
      input_tokens: Math.round(totalInputTokens * multiplier),
      output_tokens: Math.round(totalOutputTokens * multiplier),
      model: validatedModel,
    }), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    console.error(`Error in generate-RF-prompt: ${error.message}`);
    await logError('Error in generate-RF-prompt', error);

    let status = 500;
    if (error.message.includes('rate limit') || error.message.includes('429')) status = 429;
    else if (error.message.includes('invalid') || error.message.includes('missing')) status = 400;

    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: status }), { status, headers: responseHeaders });
  }
});
