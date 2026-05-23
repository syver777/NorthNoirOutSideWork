import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.75.1';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { callElevenLabsTts, DEFAULT_ELEVENLABS_MODEL_ID } from '../_shared/elevenlabs.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const modelLabApiKey = Deno.env.get('MODEL_LAB_API_KEY') ?? '';
const inworldApiKey = Deno.env.get('INWORLD_API_KEY') ?? '';
const lemonfoxApiKey = Deno.env.get('LEMONFOX_API_KEY') ?? '';
const speechifyApiKey = Deno.env.get('SPEECHIFY_API_KEY') ?? '';
const elevenLabsApiKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';
const workspaceId = Deno.env.get('INWORLD_WORKSPACE_ID') ?? 'default-ujsa1wysgyitfqg3ixpqka';

if (!supabaseUrl || !supabaseKey || !modelLabApiKey) {
  throw new Error('SUPABASE_URL, ANON_KEY, or MODEL_LAB_API_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Add helper function to normalize voice IDs
function normalizeVoiceId(voiceId: string): string {
  return voiceId.replace(/\s+/g, '_');
}

// UPDATED: Helper function to ensure proper workspace voice ID format only for clone voices
function ensureProperWorkspaceVoiceId(voiceId: string, workspaceId: string): string {
  // Only format if it's already a workspace voice (contains __)
  if (voiceId.includes('__')) {
    // If it already has workspace format, extract just the voice name and re-format
    const voiceName = voiceId.split('__').pop();
    return `${workspaceId}__${voiceName}`;
  } else {
    // Regular voice - return as-is (no workspace prefix)
    return voiceId;
  }
}

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

interface RequestBody {
  prompt: string;
  voice_id: string;
  language: string;
  speed: number;
  model_version: 'v7' | 'lemonfox' | 'speechify' | 'clone' | 'elevenlabs';
  volume?: number;
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
  /** Required when model_version === 'elevenlabs'. */
  elevenlabs_model_id?: string;
}

function validateInputs(data: RequestBody): string | null {
  if (!data.prompt || typeof data.prompt !== 'string' || data.prompt.trim().length === 0) return 'Missing or invalid prompt';
  if (!data.voice_id || typeof data.voice_id !== 'string') return 'Missing or invalid voice_id';
  if (!data.language || typeof data.language !== 'string') return 'Missing or invalid language';
  if (typeof data.speed !== 'number' || data.speed < 0.5 || (data.model_version === 'lemonfox' ? data.speed > 4.0 : data.speed > 2.0)) return 'Invalid speed';
  if (!['v7', 'lemonfox', 'speechify', 'clone', 'elevenlabs'].includes(data.model_version)) return 'Invalid model_version';
  if (data.volume !== undefined && (typeof data.volume !== 'number' || data.volume < 1.0 || data.volume > 8.0)) return 'Invalid volume range (1.0-8.0)';

  // Validate clone voice fields if model_version is 'clone'
  if (data.model_version === 'clone') {
    if (!data.clone_voice_name || typeof data.clone_voice_name !== 'string') return 'Missing or invalid clone_voice_name for clone model';
    if (!data.clone_voice_url || typeof data.clone_voice_url !== 'string') return 'Missing or invalid clone_voice_url for clone model';
    if (!data.clone_language || typeof data.clone_language !== 'string') return 'Missing or invalid clone_language for clone model';
  }

  return null;
}

async function fetchAudio(fetchUrl: string, maxAttempts: number = 20, defaultDelay: number = 30): Promise<string | null> {
  const data = { key: modelLabApiKey };

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const result = await response.json();
      const status = result.status;

      if (status === 'success' && result.output && result.output[0]) {
        return result.output[0];
      } else if (['processing', 'queued'].includes(status)) {
        const eta = result.eta || defaultDelay;
        console.log(`Audio status: ${status}, waiting ${eta} seconds... (Attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, eta * 1000));
      } else {
        console.log(`Unexpected status: ${JSON.stringify(result)}`);
        return null;
      }
    } catch (error: any) {
      console.error(`Error fetching audio: ${error.message}`);
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, defaultDelay * 1000));
      } else {
        return null;
      }
    }
  }

  console.log('Max attempts reached, audio not ready.');
  return null;
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
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    const { readable, writable } = new TransformStream();
    const response = new Response(readable, { headers: responseHeaders, status: 200 });

    (async () => {
      const writer = writable.getWriter();
      try {
        const { prompt, voice_id, language, speed, model_version, volume, clone_voice_name, clone_voice_url, clone_language, elevenlabs_model_id } = payload;

        console.log(`Processing request: model=${model_version}, voice=${voice_id}, language=${language}, speed=${speed}`);

        let audioBase64: string | undefined;
        let tokens: number;

        if (model_version === 'elevenlabs') {
          const elevenResult = await callElevenLabsTts({
            apiKey: elevenLabsApiKey,
            voiceId: voice_id,
            modelId: elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID,
            text: prompt,
            speed,
          });
          audioBase64 = elevenResult.audio_base64;
          tokens = elevenResult.tokens;
        } else if (model_version === 'lemonfox') {
          // Lemonfox TTS generation
          if (!lemonfoxApiKey) {
            throw new Error('LEMONFOX_API_KEY is not set for lemonfox model');
          }

          const clampedSpeed = Math.max(0.5, Math.min(4.0, speed));
          if (clampedSpeed !== speed) {
            console.log(`Speed clamped to ${clampedSpeed} for Lemonfox API`);
          }

          const url = 'https://eu-api.lemonfox.ai/v1/audio/speech';
          const data = {
            input: prompt,
            voice: voice_id,
            language: language,
            response_format: 'mp3',
            speed: clampedSpeed,
            word_timestamps: false,
          };

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${lemonfoxApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Lemonfox HTTP ${response.status}: ${errorText}`);
          }

          // For Lemonfox, we get the audio directly as binary data
          const audioBuffer = await response.arrayBuffer();
          const audioBytes = new Uint8Array(audioBuffer);
          
          // Convert to base64
          let binary = '';
          for (let i = 0; i < audioBytes.byteLength; i++) {
            binary += String.fromCharCode(audioBytes[i]);
          }
          audioBase64 = btoa(binary);
          tokens = prompt.length * 2; // Lemonfox uses 2x tokens like in Python

        } else if (model_version === 'speechify') {
          // Speechify TTS generation
          if (!speechifyApiKey) {
            throw new Error('SPEECHIFY_API_KEY is not set for speechify model');
          }

          // Clamp speed to 0.5-1.5 range and convert to SSML percentage
          const clampedSpeed = Math.max(0.5, Math.min(1.5, speed));
          if (clampedSpeed !== speed) {
            console.log(`Speed clamped to ${clampedSpeed} for Speechify API`);
          }

          // Wrap text in SSML for speed control if not 1.0
          let ssmlText: string;
          const hasBreakTags = prompt.includes('<break');
          if (clampedSpeed !== 1.0) {
            const adjustment = Math.round((clampedSpeed - 1) * 100);
            const rate = `${adjustment >= 0 ? '+' : ''}${adjustment}%`;
            ssmlText = `<speak><prosody rate="${rate}">${prompt}</prosody></speak>`;
          } else if (hasBreakTags) {
            // Wrap in <speak> tags when break tags are present for proper SSML parsing
            ssmlText = `<speak>${prompt}</speak>`;
          } else {
            ssmlText = prompt;
          }

          const url = 'https://api.sws.speechify.com/v1/audio/speech';
          const data = {
            input: ssmlText,
            voice_id: voice_id,
            audio_format: 'mp3',
            options: {
              loudness_normalization: true,
              text_normalization: true
            }
          };

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${speechifyApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Speechify HTTP ${response.status}: ${errorText}`);
          }

          const result = await response.json();
          if (!result.audio_data) {
            throw new Error('No audio_data in Speechify response');
          }

          audioBase64 = result.audio_data;
          // Use actual billable count if available, otherwise estimate
          const actualChars = result.billable_characters_count || prompt.length;
          tokens = actualChars * 8; // Speechify uses 8x tokens

        } else { // v7, clone: Use standard TTS endpoint for all voice types
          if (!inworldApiKey) {
            throw new Error('INWORLD_API_KEY is not set for v7/clone model');
          }

          const clampedSpeed = Math.max(0.5, Math.min(1.5, speed));
          if (clampedSpeed !== speed) {
            console.log(`Speed clamped to ${clampedSpeed} for Inworld API`);
          }

          // UPDATED: Determine voice ID format based on whether it's a custom clone or regular voice
          let voiceIdForApi: string;
          if (voice_id.includes('__')) {
            // This is a custom clone voice - ensure proper workspace format
            voiceIdForApi = ensureProperWorkspaceVoiceId(voice_id, workspaceId);
            voiceIdForApi = normalizeVoiceId(voiceIdForApi);
          } else {
            // This is a regular v7 voice - use as-is
            voiceIdForApi = voice_id;
          }

          // Always use the standard TTS endpoint
          const url = 'https://api.inworld.ai/tts/v1/voice';
          const data = {
            text: prompt,
            voiceId: voiceIdForApi,
            modelId: 'inworld-tts-1.5-mini',
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: clampedSpeed,
            },
          };

          console.log(`Using TTS endpoint for voice: ${voice_id} -> API voice ID: ${voiceIdForApi}`);
          console.log(`API URL: ${url}`);
          console.log(`Request data:`, JSON.stringify(data, null, 2));

          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${inworldApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
          });

          console.log(`Inworld API response status: ${response.status}`);

          if (!response.ok) {
            const errorText = await response.text();
            console.error(`Inworld API error: ${response.status} - ${errorText}`);
            throw new Error(`Inworld HTTP ${response.status}: ${errorText}`);
          }

          const result = await response.json();
          console.log(`Inworld API response:`, JSON.stringify(result, null, 2));
          
          if (!result.audioContent) {
            console.error('Missing audioContent in Inworld response:', result);
            throw new Error('No audioContent in Inworld response');
          }

          audioBase64 = result.audioContent;
          tokens = result.usage?.processedCharactersCount || prompt.length * 4;
        }

        const responseData = { audio_base64: audioBase64, tokens };

        console.log(`Returning response with keys: ${Object.keys(responseData).join(', ')}`);
        
        await writer.write(new TextEncoder().encode(JSON.stringify(responseData)));

      } catch (error: any) {
        console.error('Error in generate-audio:', error);
        await logError('Error in generate-audio', error);
        await writer.write(new TextEncoder().encode(JSON.stringify({ error: error.message || 'Internal server error', code: 500 })));
      } finally {
        writer.close();
        const elapsed = Date.now() - startTime;
        if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
      }
    })();

    return response;
  } catch (error: any) {
    await logError('Error in generate-audio', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders }
    );
  }
});



