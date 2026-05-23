import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Image } from 'https://deno.land/x/imagescript@1.2.15/mod.ts';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { getIsLegacyPlan, imageTokens } from '../_shared/tokenCosts.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';
const openaiApiKey = Deno.env.get('OPENAI_API_KEY') ?? '';
const falApiKey = Deno.env.get('FAL_KEY') ?? '';
const xaiApiKey = Deno.env.get('XAI_API_KEY') ?? '';

if (!supabaseUrl || !supabaseKey || !deepseekApiKey || !openaiApiKey || !supabaseServiceRoleKey || !falApiKey) {
  throw new Error('SUPABASE_URL, PUBLIC_KEY, DEEPSEEK_API_KEY, SECRET_KEY, OPENAI_API_KEY, or FAL_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);



async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        message,
        details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) console.error('Failed to log error to database:', dbError);
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

async function cropTo16x9(imageData: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    console.log('Starting image crop to 16:9...');
    
    // Decode the image from the buffer (this is the key fix)
    const image = await Image.decode(new Uint8Array(imageData));
    console.log(`Original image dimensions: ${image.width}x${image.height}`);
    
    // Calculate 16:9 crop dimensions
    const targetRatio = 16 / 9;
    const currentRatio = image.width / image.height;
    
    // If already close to 16:9, return original
    if (Math.abs(currentRatio - targetRatio) < 0.01) {
      console.log('Image already 16:9, no cropping needed');
      return imageData;
    }
    
    // Center crop to 16:9
    const targetHeight = Math.floor(image.width / targetRatio);
    const top = Math.floor((image.height - targetHeight) / 2);
    
    console.log(`Cropping to: ${image.width}x${targetHeight}, top offset: ${top}`);
    
    // Crop the image
    const cropped = image.crop(0, top, image.width, targetHeight);
    
    // Resize to standard HD (1920x1080) for consistent output
    const resized = cropped.resize(1920, 1080, Image.RESIZE_LANCZOS);
    console.log(`Final image dimensions: 1920x1080`);
    
    // Encode back to PNG
    const processedImageData = await resized.encode();
    
    console.log('Image processing completed successfully');
    return processedImageData.buffer;
  } catch (error) {
    console.error('Error processing image:', error);
    // Return original image data if processing fails
    return imageData;
  }
}

interface RequestBody {
  prompt: string;
  image_number: number;
  task_id?: string;
  image_model: string;
}

function validateInputs(data: RequestBody): string | null {
  if (!data.prompt || typeof data.prompt !== 'string' || data.prompt.trim().length === 0) return 'Missing or invalid prompt';
  if (typeof data.image_number !== 'number' || data.image_number < 1) return 'Missing or invalid image_number';
  if (!data.image_model || typeof data.image_model !== 'string') return 'Missing or invalid image_model';
  if (!['imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'grok-imagine-image', 'seedream-4.5', 'nano-banana-pro'].includes(data.image_model)) return 'Invalid image_model. Must be one of: imagen-4-fast, gpt-image-1-mini, imagen-4-ultra, flux-2-dev, grok-imagine-image, seedream-4.5, nano-banana-pro';
  return null;
}

function getSystemPrompt(language: string, imageModel: string = ''): string {
  const isSeedream = imageModel === 'seedream-4.5';
  
  const seedreamExtraGuidelines = `

CRITICAL SEEDREAM-SPECIFIC SAFETY REQUIREMENTS:
SEEDREAM IS EXTREMELY SENSITIVE - APPLY AGGRESSIVE TRANSFORMATIONS:

1. RESTING/LYING POSITIONS (HIGHEST PRIORITY):
   - "lying" → "standing upright", "walking"
   - "resting on" → "standing beside", "walking near"
   - "resting peacefully" → "standing peacefully", "walking calmly"
   - "sleeping" → "standing in contemplation", "seated upright on a chair"
   - "collapsed" → "standing", "positioned upright"
   - ANY horizontal position → vertical/upright position

2. VULNERABILITY INDICATORS:
   - "tattered clothing" → "clean, well-maintained clothing", "simple garments"
   - "exhaustion" → "peaceful contemplation", "calm presence", "thoughtful expression"
   - "weathered" → "textured", "detailed", "classic"
   - "weak" → "peaceful", "calm", "contemplative"
   - "distressed" → "thoughtful", "reflective", "serene"

3. OBSERVING/WATCHING SCENES:
   - If characters are watching someone vulnerable → transform to "characters standing together in conversation"
   - "observing" → "standing nearby", "gathered in discussion"
   - Remove all implications of surveillance or observation of vulnerable people

4. BODY/ANATOMICAL TERMS:
   - "figure" → "character", "person"
   - "form" → "shape", "presence"
   - "body" → "character", "person"
   - Avoid ALL possessive pronouns: "her/his" → "the"

5. MYTHOLOGICAL/POETIC TERMS:
   - "nymph", "sprite", "maiden", "enchantress" → "character", "person"
   - "ethereal", "otherworldly", "mystical" → "magical", "peaceful"
   - "ancient" → "old", "historical"

6. POSITIONING & MOVEMENT:
   - "stands near" → "is beside"
   - "moving as if alive" → "moving gently"
   - "swirling around her/his" → "moving around the character"
   - Keep all movements simple and non-dramatic

TRANSFORMATION STRATEGY FOR SEEDREAM:
- Convert ALL vulnerable scenes to active, upright, empowered scenes
- Replace distress with peace, contemplation, or calm
- Remove all observation of vulnerable people
- Use only simple, neutral descriptors
- Avoid all poetic or atmospheric language that could suggest vulnerability`;

  const prompts = {
    english: `You are an expert visual storyteller specializing in creating safe, family-friendly image prompts. Your task is to rewrite the following image prompt to ensure it fully complies with AI content policies while preserving the artistic vision and emotional impact.

CRITICAL SAFETY GUIDELINES:
- Replace trigger words: "child/children" → "young person/young people", "kid/kids" → "youth", "baby/babies" → "infant"
- Replace anatomical terms: "Human Body" → "Human Figure", "Nervous System" → "Energy Network", "muscles" → "form", "anatomical" → "structural"
- Transform private/intimate settings: "bedroom" → "cozy reading nook", "library corner", "garden pavilion", or "peaceful study"
- Modify sleeping contexts: "sleeping in bed" → "resting peacefully in a hammock", "napping in a garden", "relaxing on a comfortable chair"
- **CRITICAL FOR LYING/RESTING SCENES**: "lying on" → "standing beside", "resting on" → "standing near", "collapsed" → "standing", ANY horizontal position → vertical upright position
- **REMOVE ALL VULNERABILITY**: "tattered clothing" → "clean simple clothing", "exhaustion" → "peaceful contemplation", "distressed" → "thoughtful", "weathered" → "detailed"
- **TRANSFORM OBSERVATION OF VULNERABLE PEOPLE**: If someone is watching/observing a vulnerable person, change to "characters standing together in conversation" or "people gathered in peaceful discussion"
- Ensure fully clothed descriptions: Always specify "fully clothed", "wearing comfortable clothes", "dressed in cozy attire", "draped in flowing garments"
- Use safe, public contexts: Libraries, gardens, living rooms, studies, outdoor spaces
- Avoid any language that could be misinterpreted as intimate or inappropriate
- Avoid any direct body part mentions or anatomical descriptions
- Focus on "silhouette", "form", "presence", "figure" rather than physical anatomy
- Focus on wholesome, family-friendly scenarios${isSeedream ? seedreamExtraGuidelines : ''}

TRANSFORMATION APPROACH:
- Maintain the core emotional message and visual style
- Replace problematic settings with safe, public, or neutral spaces
- **AGGRESSIVELY transform vulnerable positions to active, upright, empowered positions**
- Keep the same lighting, atmosphere, and artistic direction
- Preserve the sense of peace, wonder, beauty, or whatever emotion was intended
- Use age-appropriate, respectful language throughout
- Ensure all human subjects are described as "fully clothed" and in appropriate contexts
- Transform any anatomical references to abstract or metaphorical descriptions
- **For ANY scene with people lying down, resting on surfaces, or in vulnerable positions: TRANSFORM to standing, walking, or sitting upright positions**

SAFE ALTERNATIVES FOR COMMON SCENARIOS:
- Bedroom scene → Library reading corner, garden gazebo, cozy living room
- Sleeping → Peaceful rest, quiet contemplation, gentle relaxation
- Night scene → Evening twilight, soft indoor lighting, gentle illumination
- Private space → Public park, community garden, family living area
- Human Body → Fully clothed human figure
- Anatomical terms → Energy patterns, structural forms, flowing essence
- **Lying/resting on ground/beach/surface → Standing beside, walking near, sitting upright on chair/bench**
- **Tattered/weathered clothing → Clean, simple, well-maintained clothing**
- **Exhaustion/distress → Peaceful contemplation, thoughtful expression, calm presence**
- **People observing someone vulnerable → People standing together in conversation, gathered in peaceful discussion**

Return ONLY the rewritten prompt in English, ensuring it captures the essence and beauty of the original while being completely safe for AI image generation.`,
    
    spanish: `Eres un narrador visual experto especializado en crear prompts de imagen seguros y familiares. Tu tarea es reescribir el siguiente prompt de imagen para asegurar que cumpla completamente con las políticas de contenido de IA mientras preservas la visión artística y el impacto emocional.

DIRECTRICES CRÍTICAS DE SEGURIDAD:
- Reemplaza palabras desencadenantes: "niño/niños" → "persona joven/personas jóvenes", "bebé/bebés" → "infante"
- Reemplaza términos anatómicos: "Cuerpo Humano" → "Figura Humana", "Sistema Nervioso" → "Red de Energía", "músculos" → "forma", "anatómico" → "estructural"
- Transforma ambientes privados/íntimos: "dormitorio" → "rincón de lectura acogedor", "esquina de biblioteca", "pabellón de jardín", o "estudio pacífico"
- Modifica contextos de dormir: "durmiendo en cama" → "descansando pacíficamente en una hamaca", "durmiendo en un jardín", "relajándose en una silla cómoda"
- Asegura descripciones completamente vestidas: Siempre especifica "completamente vestido", "usando ropa cómoda", "vestido con atuendo acogedor", "envuelto en vestimentas fluidas"
- Usa contextos seguros y públicos: Bibliotecas, jardines, salas de estar, estudios, espacios exteriores
- Evita cualquier lenguaje que pueda malinterpretarse como íntimo o inapropiado
- Evita cualquier mención directa de partes del cuerpo o descripciones anatómicas
- Enfócate en "silueta", "forma", "presencia", "figura" en lugar de anatomía física
- Enfócate en escenarios sanos y familiares${isSeedream ? seedreamExtraGuidelines : ''}

ENFOQUE DE TRANSFORMACIÓN:
- Mantén el mensaje emocional central y el estilo visual
- Reemplaza ambientes problemáticos con espacios seguros, públicos o neutrales
- Mantén la misma iluminación, atmósfera y dirección artística
- Preserva el sentido de paz, asombro, belleza o cualquier emoción que se pretendía
- Usa lenguaje apropiado para la edad y respetuoso en todo momento
- Asegura que todos los sujetos humanos se describan como "completamente vestidos" y en contextos apropiados
- Transforma cualquier referencia anatómica a descripciones abstractas o metafóricas

Devuelve SOLO el prompt reescrito en español, asegurando que capture la esencia y belleza del original mientras sea completamente seguro para la generación de imágenes por IA.`,
    
    german: `Du bist ein Experte für visuelles Storytelling, der sich auf die Erstellung sicherer, familienfreundlicher Bildprompts spezialisiert hat. Deine Aufgabe ist es, den folgenden Bildprompt umzuschreiben, um sicherzustellen, dass er vollständig den KI-Inhaltsrichtlinien entspricht und gleichzeitig die künstlerische Vision und emotionale Wirkung bewahrt.

KRITISCHE SICHERHEITSRICHTLINIEN:
- Ersetze Auslösewörter: "Kind/Kinder" → "junge Person/junge Menschen", "Baby/Babys" → "Kleinkind"
- Ersetze anatomische Begriffe: "Menschlicher Körper" → "Menschliche Figur", "Nervensystem" → "Energienetzwerk", "Muskeln" → "Form", "anatomisch" → "strukturell"
- Verwandle private/intime Umgebungen: "Schlafzimmer" → "gemütliche Leseecke", "Bibliotheksecke", "Gartenpavillon", oder "friedliches Arbeitszimmer"
- Modifiziere Schlafkontexte: "im Bett schlafen" → "friedlich in einer Hängematte ruhen", "im Garten dösen", "in einem bequemen Stuhl entspannen"
- Stelle vollständig bekleidete Beschreibungen sicher: Spezifiziere immer "vollständig bekleidet", "bequeme Kleidung tragend", "in gemütlicher Kleidung gekleidet", "in fließende Gewänder gehüllt"
- Verwende sichere, öffentliche Kontexte: Bibliotheken, Gärten, Wohnzimmer, Arbeitszimmer, Außenbereiche
- Vermeide jede Sprache, die als intim oder unangemessen missverstanden werden könnte
- Vermeide direkte Körperteil-Erwähnungen oder anatomische Beschreibungen
- Konzentriere dich auf "Silhouette", "Form", "Präsenz", "Figur" anstatt auf physische Anatomie
- Konzentriere dich auf gesunde, familienfreundliche Szenarien${isSeedream ? seedreamExtraGuidelines : ''}

TRANSFORMATIONSANSATZ:
- Bewahre die zentrale emotionale Botschaft und den visuellen Stil
- Ersetze problematische Umgebungen mit sicheren, öffentlichen oder neutralen Räumen
- Behalte die gleiche Beleuchtung, Atmosphäre und künstlerische Richtung
- Erhalte das Gefühl von Frieden, Staunen, Schönheit oder welche Emotion auch immer beabsichtigt war
- Verwende durchgehend altersgerechte, respektvolle Sprache
- Stelle sicher, dass alle menschlichen Subjekte als "vollständig bekleidet" und in angemessenen Kontexten beschrieben werden
- Transformiere anatomische Referenzen zu abstrakten oder metaphorischen Beschreibungen

Gib NUR den umgeschriebenen Prompt auf Deutsch zurück und stelle sicher, dass er die Essenz und Schönheit des Originals einfängt, während er vollständig sicher für KI-Bildgenerierung ist.`,
    
    french: `Vous êtes un expert en narration visuelle spécialisé dans la création de prompts d'image sûrs et familiaux. Votre tâche est de réécrire le prompt d'image suivant pour vous assurer qu'il respecte entièrement les politiques de contenu IA tout en préservant la vision artistique et l'impact émotionnel.

DIRECTIVES CRITIQUES DE SÉCURITÉ:
- Remplacez les mots déclencheurs: "enfant/enfants" → "jeune personne/jeunes personnes", "bébé/bébés" → "nourrisson"
- Remplacez les termes anatomiques: "Corps Humain" → "Figure Humaine", "Système Nerveux" → "Réseau d'Énergie", "muscles" → "forme", "anatomique" → "structurel"
- Transformez les environnements privés/intimes: "chambre" → "coin lecture confortable", "coin bibliothèque", "pavillon de jardin", ou "bureau paisible"
- Modifiez les contextes de sommeil: "dormant dans un lit" → "se reposant paisiblement dans un hamac", "faisant la sieste dans un jardin", "se relaxant dans une chaise confortable"
- Assurez des descriptions entièrement vêtues: Spécifiez toujours "entièrement vêtu", "portant des vêtements confortables", "habillé de manière douillette", "drapé dans des vêtements fluides"
- Utilisez des contextes sûrs et publics: Bibliothèques, jardins, salons, bureaux, espaces extérieurs
- Évitez tout langage qui pourrait être mal interprété comme intime ou inapproprié
- Évitez toute mention directe de parties du corps ou descriptions anatomiques
- Concentrez-vous sur "silhouette", "forme", "présence", "figure" plutôt que sur l'anatomie physique
- Concentrez-vous sur des scénarios sains et familiaux${isSeedream ? seedreamExtraGuidelines : ''}

APPROCHE DE TRANSFORMATION:
- Maintenez le message émotionnel central et le style visuel
- Remplacez les environnements problématiques par des espaces sûrs, publics ou neutres
- Gardez le même éclairage, atmosphère et direction artistique
- Préservez le sentiment de paix, d'émerveillement, de beauté ou quelle que soit l'émotion voulue
- Utilisez un langage approprié à l'âge et respectueux tout au long
- Assurez-vous que tous les sujets humains soient décrits comme "entièrement vêtus" et dans des contextes appropriés
- Transformez toute référence anatomique en descriptions abstraites ou métaphoriques

Retournez SEULEMENT le prompt réécrit en français, en vous assurant qu'il capture l'essence et la beauté de l'original tout en étant complètement sûr pour la génération d'images IA.`
  };

  return prompts[language as keyof typeof prompts] || prompts.english;
}

function applySeedreamSafetyFilter(prompt: string): string {
  const seedreamReplacements = {
    // CRITICAL: Resting/lying positions (must come first)
    'lying on': 'standing beside',
    'lying down': 'standing upright',
    'lying in': 'positioned in',
    'resting on the': 'standing near the',
    'resting on': 'standing beside',
    'resting peacefully on': 'standing peacefully beside',
    'resting peacefully': 'standing peacefully',
    'resting in': 'standing in',
    'collapsed on': 'standing near',
    'sleeping on': 'standing beside',
    'sleeping in': 'resting upright in a chair in',
    
    // Vulnerability indicators
    'tattered clothing': 'simple clean clothing',
    'tattered': 'simple',
    'weathered textures': 'textured details',
    'weathered': 'detailed',
    'exhaustion': 'peaceful contemplation',
    'exhausted': 'contemplative',
    'weak': 'peaceful',
    'distressed': 'thoughtful',
    
    // Observation/watching
    'observing': 'standing nearby',
    'watching': 'standing near',
    'looking towards': 'standing with',
    'look towards': 'stand with',
    
    // Body/anatomical terms
    'figure': 'character',
    'form': 'shape',
    'body': 'character',
    
    // Mythological terms
    'nymph': 'character',
    'sprite': 'character', 
    'maiden': 'person',
    'enchantress': 'character',
    
    // Atmospheric terms
    'misty': 'foggy',
    'mist': 'fog',
    'ethereal': 'magical',
    'otherworldly': 'magical',
    'mystical': 'magical',
    'ancient stories': 'old tales',
    
    // Possessive pronouns
    'her dress': 'the dress',
    'his dress': 'the dress', 
    'her face': 'the face',
    'his face': 'the face',
    'her expression': 'the expression',
    'his expression': 'the expression',
    'her hair': 'the hair',
    'his hair': 'the hair',
    'her clothing': 'the clothing',
    'his clothing': 'the clothing',
    
    // Movement descriptions
    'flowing hair': 'hair',
    'swirling around her': 'moving around the character',
    'swirling around his': 'moving around the character',
    'moving as if alive': 'moving gently',
    'stands near': 'is beside',
    'woven from': 'made of',
    'shifting between': 'changing to'
  };

  let filteredPrompt = prompt;
  
  // Apply word replacements (order matters - do critical ones first)
  for (const [risky, safe] of Object.entries(seedreamReplacements)) {
    const regex = new RegExp(risky, 'gi');
    filteredPrompt = filteredPrompt.replace(regex, safe);
  }

  return filteredPrompt;
}

async function rewritePromptWithDeepSeek(prompt: string, language: string = 'english', imageModel: string = ''): Promise<string> {
  const systemPrompt = getSystemPrompt(language, imageModel);
  const userPrompt = `Original prompt: ${prompt}`;

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${deepseekApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 4000,
      temperature: 0.7,
      stream: true, // Enable streaming for DeepSeek
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: HTTP ${response.status} - ${errorText}`);
  }

  // Handle streaming response
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

  let jsonOutput = content.trim();
  if (jsonOutput.startsWith('```')) jsonOutput = jsonOutput.replace(/```(json)?/g, '').trim();
  return jsonOutput;
}

async function generateImagenFastImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Imagen4-Fast] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      // Step 1: Submit to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/imagen4/preview/fast', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Imagen4-Fast] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Imagen4-Fast] Request queued with ID: ${requestId}`);

      // Step 2: Poll status URL, then fetch result when complete
      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/imagen4/preview/fast/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/imagen4/preview/fast/requests/${requestId}`;
      const maxPolls = 60;

      // Initial wait before first poll
      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Imagen4-Fast] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Imagen4-Fast] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Imagen4-Fast] Generation completed successfully`);
          return { image_url, tokens: 14000 };
        } else if (status === 'FAILED') {
          throw new Error(`Generation failed: ${statusData.error || 'Unknown error'}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Imagen4-Fast] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Imagen4-Fast] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-fast image after 5 attempts');
}

async function generateGptImageMiniImage(prompt: string): Promise<{ image_url: string; tokens: number; imageData: ArrayBuffer }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 360000);

      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-image-1-mini",
          prompt: modifiedPrompt,
          n: 1,
          quality: "high",
          size: "1536x1024"
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        
        // Check for OpenAI safety violations
        if (response.status === 400 && errorText.includes('safety_violations')) {
          const safetyError = new Error(`Content filtered by safety system: ${errorText}`);
          safetyError.name = 'ModelUnavailableError';
          throw safetyError;
        }
        
        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      if (!result.data || !Array.isArray(result.data) || result.data.length === 0) {
        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error('No image data in response');
      }

      // OpenAI returns base64 data by default
      const imageB64 = result.data[0].b64_json;
      if (!imageB64) {
        throw new Error('No base64 image data in response');
      }

      // Convert base64 to ArrayBuffer
      const binaryString = atob(imageB64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Process image to 16:9 aspect ratio
      const processedImageData = await cropTo16x9(bytes.buffer);

      // Create a data URL for the return
      const uint8Array = new Uint8Array(processedImageData);
      let binaryString2 = '';
      for (let i = 0; i < uint8Array.length; i++) {
        binaryString2 += String.fromCharCode(uint8Array[i]);
      }
      const base64String = btoa(binaryString2);
      const imageUrl = `data:image/png;base64,${base64String}`;

      return { image_url: imageUrl, tokens: 30000, imageData: processedImageData };
    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error; // Re-throw model unavailable errors immediately
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate gpt-image-1-mini image after 5 attempts');
}

async function generateImagenUltraImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Imagen4-Ultra] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      const submitResponse = await fetch('https://queue.fal.run/fal-ai/imagen4/preview/ultra', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
          resolution: '1K',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Imagen4-Ultra] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Imagen4-Ultra] Request queued with ID: ${requestId}`);

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/imagen4/preview/ultra/requests/${requestId}`;
      const maxPolls = 60;

      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Imagen4-Ultra] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Imagen4-Ultra] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Imagen4-Ultra] Generation completed successfully`);
          return { image_url, tokens: 42000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Imagen4-Ultra] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Imagen4-Ultra] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate imagen-4-ultra image after 5 attempts');
}

async function generateFluxDevImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000]; // 10s, 20s, 30s, 40s, 50s

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Flux-2] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);
      
      // Step 1: Submit the request to fal-ai queue
      const submitResponse = await fetch('https://queue.fal.run/fal-ai/flux-2', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          image_size: "landscape_16_9",
          num_inference_steps: 28,
          num_images: 1,
          guidance_scale: 2.5,
          enable_safety_checker: false,
          output_format: "png"
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;
      
      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Flux-2] Request queued with ID: ${requestId}`);

      // Step 2: Poll for results using the result endpoint directly
      const resultUrl = `https://queue.fal.run/fal-ai/flux-2/requests/${requestId}`;
      const maxPolls = 60; // Poll for up to 120 seconds
      
      // Wait 5 seconds before first poll to give the queue time to process
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Wait 30 seconds before first poll to allow fal-ai to process the request
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between subsequent polls
        }
        
        const resultResponse = await fetch(resultUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Key ${falApiKey}`,
          },
        });

        if (!resultResponse.ok) {
          // Log the actual error for debugging
          const errorText = await resultResponse.text().catch(() => 'Unable to read error');
          console.log(`[Flux-2] Poll ${poll + 1} failed with status ${resultResponse.status}: ${errorText}`);
          
          // 404 means not ready yet, keep polling
          if (resultResponse.status === 404) {
            continue;
          }
          // 400/422 might mean bad request or not ready, keep trying for a bit
          if ((resultResponse.status === 400 || resultResponse.status === 422) && poll < 10) {
            continue;
          }
          // Other errors or too many 400/422s, give up on this poll cycle but continue
          if (poll < maxPolls - 1) {
            continue;
          }
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${resultResponse.status}`);
        }

        const result = await resultResponse.json();
        console.log(`[Flux-2] Poll ${poll + 1} response:`, JSON.stringify(result).substring(0, 200));
        const status = result.status;
        
        if (status === 'COMPLETED' || !status) {
          // If no status field or COMPLETED, check for images
          console.log(`[Flux-2] Generation completed successfully`);
          
          // Extract image URL from fal-ai response
          let image_url = null;
          if (result.images && Array.isArray(result.images) && result.images.length > 0) {
            image_url = result.images[0].url;
          }

          if (!image_url) {
            console.log(`[Flux-2] No images in result yet, continuing to poll...`);
            continue;
          }

          return { image_url, tokens: 7000 };
        } else if (status === 'FAILED') {
          throw new Error(`Generation failed: ${result.error || 'Unknown error'}`);
        }
        
        // Still IN_PROGRESS or IN_QUEUE, continue polling
        console.log(`[Flux-2] Poll ${poll + 1}: Status ${status}, continuing...`);
      }

      // If we exhausted polls, retry the whole request
      if (attempt < maxRetries - 1) {
        console.log('Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      
      throw new Error('Polling timeout after maximum attempts');
      
    } catch (error: any) {
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate flux-2-dev image after 5 attempts');
}

async function generateSeedreamImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Seedream-4.5] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      const submitResponse = await fetch('https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          image_size: { width: 2560, height: 1440 },
          num_images: 1,
          enable_safety_checker: false,
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[Seedream-4.5] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[Seedream-4.5] Request queued with ID: ${requestId}`);

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/text-to-image/requests/${requestId}`;
      const maxPolls = 60;

      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[Seedream-4.5] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[Seedream-4.5] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[Seedream-4.5] Generation completed successfully`);
          return { image_url, tokens: 35000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[Seedream-4.5] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[Seedream-4.5] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate seedream-4.5 image after 5 attempts');
}

async function generateNanaBananaImage(prompt: string): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO Letters, No text, and no speaking bubbles on the image. Remove letters";

  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[NanaBananaPro] Attempt ${attempt + 1}/${maxRetries} - Submitting to fal-ai...`);

      const submitResponse = await fetch('https://queue.fal.run/fal-ai/nano-banana-pro', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt: modifiedPrompt,
          aspect_ratio: '16:9',
          num_images: 1,
          output_format: 'png',
          safety_tolerance: '4',
          resolution: '1K',
        }),
      });

      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        if ([429, 500, 502, 503, 504].some(code => submitResponse.status === code) && attempt < maxRetries - 1) {
          console.log(`[NanaBananaPro] HTTP ${submitResponse.status} error, waiting before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${submitResponse.status}: ${errorText}`);
      }

      const submitResult = await submitResponse.json();
      const requestId = submitResult.request_id;

      if (!requestId) {
        throw new Error('No request_id received from fal-ai');
      }

      console.log(`[NanaBananaPro] Request queued with ID: ${requestId}`);

      const statusUrl = submitResult.status_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}/status`;
      const responseUrl = submitResult.response_url || `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${requestId}`;
      const maxPolls = 60;

      await new Promise(resolve => setTimeout(resolve, 5000));

      for (let poll = 0; poll < maxPolls; poll++) {
        if (poll > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const statusResponse = await fetch(statusUrl, {
          method: 'GET',
          headers: { 'Authorization': `Key ${falApiKey}` },
        });

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text().catch(() => 'Unable to read error');
          console.log(`[NanaBananaPro] Poll ${poll + 1} status check failed (${statusResponse.status}): ${errorText}`);
          if (poll < maxPolls - 1) continue;
          throw new Error(`Polling failed after ${poll + 1} attempts with status ${statusResponse.status}`);
        }

        const statusData = await statusResponse.json();
        const status = statusData.status;
        console.log(`[NanaBananaPro] Poll ${poll + 1}: Status ${status}`);

        if (status === 'COMPLETED') {
          const resultResponse = await fetch(responseUrl, {
            method: 'GET',
            headers: { 'Authorization': `Key ${falApiKey}` },
          });
          if (!resultResponse.ok) {
            throw new Error(`Failed to fetch result: HTTP ${resultResponse.status}`);
          }
          const result = await resultResponse.json();
          const image_url = result.images?.[0]?.url;
          if (!image_url) {
            throw new Error('No image URL in completed result');
          }
          console.log(`[NanaBananaPro] Generation completed successfully`);
          return { image_url, tokens: 100000 };
        } else if (status === 'FAILED') {
          const errorMsg = statusData.error || 'Unknown error';
          if (errorMsg.includes('safety') || errorMsg.includes('filtered') || errorMsg.includes('blocked')) {
            const modelError = new Error(`Content filtered: ${errorMsg}`);
            modelError.name = 'ModelUnavailableError';
            throw modelError;
          }
          throw new Error(`Generation failed: ${errorMsg}`);
        }
      }

      if (attempt < maxRetries - 1) {
        console.log('[NanaBananaPro] Polling timeout, retrying entire request...');
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw new Error('Polling timeout after maximum attempts');

    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') {
        throw error;
      }
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504'))) {
        console.log(`[NanaBananaPro] Error occurred, waiting before retry: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate nano-banana-pro image after 5 attempts');
}

async function generateGrokImage(prompt: string): Promise<{ image_url: string; tokens: number; imageData?: ArrayBuffer }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";
  const maxRetries = 5;
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      console.log(`[Grok-Imagine] Attempt ${attempt + 1}/${maxRetries} - Calling xAI...`);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 360000);

      const response = await fetch('https://api.x.ai/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${xaiApiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-imagine-image',
          prompt: modifiedPrompt,
          n: 1,
          response_format: 'b64_json',
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 400 && (errorText.toLowerCase().includes('moderation') || errorText.toLowerCase().includes('safety') || errorText.toLowerCase().includes('content'))) {
          const safetyError = new Error(`Content filtered by xAI: ${errorText}`);
          safetyError.name = 'ModelUnavailableError';
          throw safetyError;
        }
        if ([429, 500, 502, 503, 504].some(code => response.status === code) && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      const item = result?.data?.[0];
      const imageB64 = item?.b64_json;
      const inlineUrl = item?.url;

      let bytes: Uint8Array;
      if (imageB64) {
        const binaryString = atob(imageB64);
        bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      } else if (inlineUrl) {
        const imgResp = await fetch(inlineUrl);
        if (!imgResp.ok) throw new Error(`Failed to fetch grok image url: HTTP ${imgResp.status}`);
        bytes = new Uint8Array(await imgResp.arrayBuffer());
      } else {
        throw new Error('No image data in xAI response');
      }

      const processedImageData = await cropTo16x9(bytes.buffer);
      const u8 = new Uint8Array(processedImageData);
      let binStr = '';
      for (let i = 0; i < u8.length; i++) binStr += String.fromCharCode(u8[i]);
      const base64String = btoa(binStr);
      const imageUrl = `data:image/png;base64,${base64String}`;

      console.log('[Grok-Imagine] Generation completed successfully');
      return { image_url: imageUrl, tokens: 16000, imageData: processedImageData };
    } catch (error: any) {
      if (error.name === 'ModelUnavailableError') throw error;
      if (attempt < maxRetries - 1 && (error.message.includes('429') || error.message.includes('500') || error.message.includes('502') || error.message.includes('503') || error.message.includes('504') || error.name === 'AbortError')) {
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to generate grok-imagine-image after 5 attempts');
}

async function triggerFinalCompilation(groupId: string, userId: string, totalBatches: number) {
  try {
    console.log(`Triggering final compilation for group ${groupId} after completing all ${totalBatches} batches`);
    
    const response = await fetch(`${supabaseUrl}/functions/v1/process-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        group_id: groupId,
        user_id: userId,
        batch_number: totalBatches,
        total_batches: totalBatches,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to trigger final compilation: HTTP ${response.status}: ${errorText}`);
    }
    
    console.log(`Successfully triggered final compilation for group ${groupId}`);
  } catch (error: any) {
    console.error(`Error triggering final compilation for group ${groupId}:`, error.message);
    await logError(`Error triggering final compilation for group ${groupId}`, error);
    throw error;
  }
}

async function triggerNextBatch(groupId: string, userId: string, currentBatchNumber: number, totalBatches: number) {
  const retryDelays = [5000, 10000, 20000];
 
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      if (currentBatchNumber >= totalBatches) {
        console.log(`All batches completed for group ${groupId}, triggering final compilation`);
        await triggerFinalCompilation(groupId, userId, totalBatches);
        return;
      }

      const nextBatchNumber = currentBatchNumber + 1;
      console.log(`Triggering next batch ${nextBatchNumber} for group ${groupId}`);
      
      const response = await fetch(`${supabaseUrl}/functions/v1/trigger-next-image`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          group_id: groupId,
          user_id: userId,
          current_batch_number: currentBatchNumber,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if ([429, 500, 502, 503, 504, 520].some(code => response.status === code) && attempt < retryDelays.length) {
          console.log(`Retryable error ${response.status}, retrying after ${retryDelays[attempt]/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
          continue;
        }
        throw new Error(`Failed to trigger batch ${nextBatchNumber}: HTTP ${response.status}: ${errorText}`);
      }
      
      console.log(`Successfully triggered batch ${nextBatchNumber}`);
      return;
    } catch (error: any) {
      console.error(`Error in triggerNextBatch attempt ${attempt + 1}: ${error.message}`);
     
      if (attempt < retryDelays.length) {
        console.log(`Retrying after ${retryDelays[attempt]/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        continue;
      }
      
      await logError(`Error triggering batch ${currentBatchNumber + 1}`, error);
      throw error;
    }
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000;

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const payload: RequestBody = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { prompt, image_number, task_id, image_model } = payload;

    if (!task_id) {
      return new Response(JSON.stringify({ error: 'task_id is required for empty-redo', code: 400 }), { status: 400, headers: responseHeaders });
    }

    // Get task details first, including language
    const { data: task, error: taskError } = await supabase
      .from('image_tasks')
      .select('*')
      .eq('id', task_id)
      .single();

    if (taskError || !task) {
      await logError('Task not found in empty-redo', taskError || new Error('No task found'));
      return new Response(JSON.stringify({ error: 'Task not found', code: 404 }), { status: 404, headers: responseHeaders });
    }

    // Get language from task, default to english if not set
    const taskLanguage = task.language || 'english';
    console.log(`Using language: ${taskLanguage} for task ${task_id}`);
    console.log(`Original prompt being rewritten: ${prompt.substring(0, 200)}...`);

    // Rewrite the prompt using DeepSeek with the task's language and image model
    const rewrittenPrompt = await rewritePromptWithDeepSeek(prompt, taskLanguage, image_model);
    console.log(`Rewritten prompt: ${rewrittenPrompt.substring(0, 200)}...`);

    // Apply additional filtering for seedream
    let finalPrompt = rewrittenPrompt;
    if (image_model === 'seedream-4.5') {
      finalPrompt = applySeedreamSafetyFilter(rewrittenPrompt);
      console.log(`Applied seedream safety filter. Final prompt: ${finalPrompt.substring(0, 200)}...`);
    }

    // Update the batch column in image_tasks table
    const { error: updateError } = await supabase
      .from('image_tasks')
      .update({
        batch: [{ text: finalPrompt, index: image_number }],
        updated_at: new Date().toISOString(),
      })
      .eq('id', task_id);

    if (updateError) {
      await logError(`Failed to update batch for task ${task_id}`, updateError);
      console.warn(`Continuing image generation despite batch update failure: ${updateError.message}`);
    } else {
      console.log(`Successfully updated batch for task ${task_id}`);
    }

    // Handle flux-2-dev with background processing
    if (image_model === 'flux-2-dev') {
      // Update task to running status
      await supabase
        .from('image_tasks')
        .update({
          status: 'running',
          updated_at: new Date().toISOString(),
        })
        .eq('id', task_id);

      // Return 202 immediately for flux processing
      const response = new Response(
        JSON.stringify({ 
          status: 'processing',
          message: 'Flux-2-dev processing in background',
          task_id,
          image_number 
        }), 
        { status: 202, headers: responseHeaders }
      );

      // Process in background using EdgeRuntime.waitUntil
      EdgeRuntime.waitUntil(
        (async () => {
          try {
            console.log(`Background flux empty-redo started for image ${image_number}, task ${task_id}`);
            const result = await generateFluxDevImage(finalPrompt);
            // Override hardcoded LEGACY token count with canonical legacy-aware price.
            const isLegacyFlux = await getIsLegacyPlan(task.user_id);
            result.tokens = imageTokens(isLegacyFlux, image_model);
            console.log(`Flux generation completed for image ${image_number}`);

            // Download image
            const imageResponse = await fetch(result.image_url);
            if (!imageResponse.ok) throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
            const imageData = await imageResponse.arrayBuffer();

            // Create image path and upload
            const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
            const folderTimestamp = task.folder_timestamp || new Date().toISOString().replace(/[:.]/g, '-');
            const imageFolder = `documents/${task.user_id}/${task.group_id}/${sanitizedTitle}_${folderTimestamp}`;
            const imagePath = `${imageFolder}/${image_number}.png`;

            await supabase.storage.from('stories').upload(imagePath, imageData, { contentType: 'image/png' });
            const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
            const batchContent = `Image ${image_number} saved to: ${urlData.publicUrl}`;

            // Update task to completed
            await supabase
              .from('image_tasks')
              .update({
                status: 'completed',
                batch_output: batchContent,
                progress: 100,
                tokens: result.tokens,
                token_updated: true,
                updated_at: new Date().toISOString(),
              })
              .eq('id', task_id);

            // Trigger next batch
            await triggerNextBatch(task.group_id, task.user_id, task.batch_number, task.total_batches);
            console.log(`Background flux empty-redo completed for image ${image_number}`);
          } catch (error: any) {
            console.error(`Background flux empty-redo failed for image ${image_number}:`, error);
            await logError('Background flux empty-redo error', error);
            await supabase
              .from('image_tasks')
              .update({ 
                status: 'pending', 
                error: `Flux empty-redo failed: ${error.message}`, 
                updated_at: new Date().toISOString() 
              })
              .eq('id', task_id);
          }
        })()
      );

      return response;
    }

    // Handle all other models synchronously
    let result: { image_url: string; tokens: number; imageData?: ArrayBuffer };

    if (image_model === 'imagen-4-fast') {
      result = await generateImagenFastImage(finalPrompt);
    } else if (image_model === 'gpt-image-1-mini') {
      result = await generateGptImageMiniImage(finalPrompt);
    } else if (image_model === 'imagen-4-ultra') {
      result = await generateImagenUltraImage(finalPrompt);
    } else if (image_model === 'seedream-4.5') {
      result = await generateSeedreamImage(finalPrompt);
    } else if (image_model === 'grok-imagine-image') {
      result = await generateGrokImage(finalPrompt);
    } else if (image_model === 'nano-banana-pro') {
      result = await generateNanaBananaImage(finalPrompt);
    } else {
      throw new Error('Invalid image_model');
    }

    // Override the model-wrapper's hardcoded LEGACY token count with the canonical
    // legacy-aware price for this user, so non-legacy users are charged the NEW rate.
    const isLegacy = await getIsLegacyPlan(task.user_id);
    result.tokens = imageTokens(isLegacy, image_model);

    // Download and upload the image (for non-GPT models) or use processed data (for GPT model)
    let imageData: ArrayBuffer;
    
    if (image_model === 'gpt-image-1-mini') {
      imageData = result.imageData!; // Use processed image data
    } else if (image_model === 'grok-imagine-image' && result.imageData) {
      imageData = result.imageData;
    } else {
      // Retry download with exponential backoff
      const maxDownloadRetries = 3;
      const downloadRetryDelays = [2000, 5000, 10000];
      let downloadSuccess = false;
      
      for (let attempt = 0; attempt < maxDownloadRetries; attempt++) {
        try {
          console.log(`Attempting to download image from ${result.image_url.substring(0, 100)}... (attempt ${attempt + 1}/${maxDownloadRetries})`);
          const imageResponse = await fetch(result.image_url, {
            headers: {
              'User-Agent': 'Mozilla/5.0'
            }
          });
          
          if (!imageResponse.ok) {
            console.warn(`Download failed with HTTP ${imageResponse.status}, attempt ${attempt + 1}/${maxDownloadRetries}`);
            if (attempt < maxDownloadRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, downloadRetryDelays[attempt]));
              continue;
            }
            throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
          }
          
          imageData = await imageResponse.arrayBuffer();
          
          if (imageData.byteLength === 0) {
            console.warn(`Downloaded image is 0 bytes, attempt ${attempt + 1}/${maxDownloadRetries}`);
            if (attempt < maxDownloadRetries - 1) {
              await new Promise(resolve => setTimeout(resolve, downloadRetryDelays[attempt]));
              continue;
            }
            throw new Error('Downloaded image is 0 bytes after all retries');
          }
          
          downloadSuccess = true;
          console.log(`Successfully downloaded image: ${imageData.byteLength} bytes`);
          break;
        } catch (error: any) {
          console.error(`Download attempt ${attempt + 1} failed:`, error.message);
          if (attempt === maxDownloadRetries - 1) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, downloadRetryDelays[attempt]));
        }
      }
      
      if (!downloadSuccess) {
        throw new Error('Failed to download image after all retries');
      }
    }

    // Create the image path
    const sanitizedTitle = task.story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const folderTimestamp = task.folder_timestamp || new Date().toISOString().replace(/[:.]/g, '-');
    const imageFolder = `documents/${task.user_id}/${task.group_id}/${sanitizedTitle}_${folderTimestamp}`;
    const imagePath = `${imageFolder}/${image_number}.png`;

    // Upload to storage
    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(imagePath, imageData, { contentType: 'image/png' });

    if (uploadError && !uploadError.message.includes('The resource already exists')) {
      throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(imagePath);
    if (!urlData?.publicUrl) throw new Error('Failed to retrieve public URL');

    const batchContent = `Image ${image_number} saved to: ${urlData.publicUrl}`;

    // Update task to completed
    await supabase
      .from('image_tasks')
      .update({
        status: 'completed',
        batch_output: batchContent,
        progress: 100,
        tokens: result.tokens,
        token_updated: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task_id);

    // Trigger next batch or final compilation
    await triggerNextBatch(task.group_id, task.user_id, task.batch_number, task.total_batches);

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(
      JSON.stringify({ image_url: result.image_url, tokens: result.tokens }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    await logError('Error in empty-redo', error);
    
    // Update task to pending if we have task_id
    if (req.method === 'POST') {
      try {
        const payload = await req.json();
        if (payload.task_id) {
          await supabase
            .from('image_tasks')
            .update({ 
              status: 'pending', 
              error: `Failed in empty-redo: ${error.message}`, 
              updated_at: new Date().toISOString() 
            })
            .eq('id', payload.task_id);
        }
      } catch (e) {
        // Ignore errors in error handling
      }
    }
    
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders }
    );
  }
});




