import { serve } from 'https://deno.land/std@0.131.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { v4 as uuidv4 } from 'https://esm.sh/uuid@9.0.0';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { callElevenLabsTts, DEFAULT_ELEVENLABS_MODEL_ID, elevenLabsTokensPerChar } from '../_shared/elevenlabs.ts';
import { planMaxTokensForUser } from '../_shared/planMaps.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceKey = Deno.env.get('SECRET_KEY') ?? '';
const modelLabApiKey = Deno.env.get('MODEL_LAB_API_KEY') ?? '';
const inworldApiKey = Deno.env.get('INWORLD_API_KEY') ?? '';
const lemonfoxApiKey = Deno.env.get('LEMONFOX_API_KEY') ?? '';
const speechifyApiKey = Deno.env.get('SPEECHIFY_API_KEY') ?? '';
const elevenLabsApiKey = Deno.env.get('ELEVENLABS_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceKey || !modelLabApiKey) {
  throw new Error('Missing SUPABASE_URL, SECRET_KEY, or MODEL_LAB_API_KEY');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Predefined clone voices (matching frontend and backend)
const predefinedCloneVoices = [
  { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
  { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
  { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
  { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
  { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
  { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
  { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
];

const planMaxTokens: Record<string, number> = {
  free: 400000,
  standard: 4000000,
  plus: 6000000,
  premium: 10000000,
  pro: 25000000,
  elite: 50000000,
  ultimate: 75000000,
  enterprise: 125000000,
};

// Add helper function to normalize voice IDs
function normalizeVoiceId(voiceId: string): string {
  return voiceId.replace(/\s+/g, '_');
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

function cleanText(text: string): string {
  text = text.replace(/\*/g, '');
  const lines = text.split('\n');
  const chapterPattern = /^Chapter \d+.*$/i;
  let firstChapterIdx: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (chapterPattern.test(lines[i].trim())) {
      firstChapterIdx = i;
      break;
    }
  }
  if (firstChapterIdx !== null) {
    lines.splice(0, firstChapterIdx);
  }
  const filteredLines = lines
    .filter(line => !chapterPattern.test(line.trim()) && line.trim().length > 0)
    .map(line => line.trim());
  return filteredLines.join(' ');
}

// Helper function to check if voice is a custom clone voice
function isCustomCloneVoice(voiceId: string): boolean {
  // Check if it's a workspace voice that's not predefined
  if (!voiceId.includes('__')) return false;
  
  // Check if it's not a predefined clone voice
  return !predefinedCloneVoices.some(v => v.voice_id === voiceId);
}

// UPDATED: Enhanced helper function to clean up custom clone voice with comprehensive storage cleanup
async function cleanupCustomCloneVoice(voiceId: string, userId: string, audioFilePath?: string | null): Promise<void> {
  try {
    console.log(`Cleaning up custom clone voice: ${voiceId}`);
    
    const requestBody: any = {
      action: 'delete',
      voice_id: voiceId
    };

    // Add audio file path if available
    if (audioFilePath) {
      requestBody.audio_file_path = audioFilePath;
    }
    
    const response = await fetch(`${supabaseUrl}/functions/v1/manage-clone-voice`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`Failed to delete custom clone voice ${voiceId}: ${errorText}`);
    } else {
      console.log(`Successfully deleted custom clone voice: ${voiceId}`);
      
      // UPDATED: After successful workspace deletion, clean up storage files
      try {
        console.log(`Cleaning up clone voice files for user ${userId}`);
        
        // List all files in user's clone_voices folder
        const { data: files, error: listError } = await supabase.storage
          .from('audio')
          .list(`${userId}/clone_voices`, {
            limit: 100,
            offset: 0
          });

        if (!listError && files && files.length > 0) {
          // Create array of file paths to delete
          const filePaths = files.map(file => `${userId}/clone_voices/${file.name}`);
          
          // Delete all clone voice files for this user
          const { error: deleteError } = await supabase.storage
            .from('audio')
            .remove(filePaths);

          if (deleteError) {
            console.warn(`Failed to delete clone voice files for user ${userId}: ${deleteError.message}`);
          } else {
            console.log(`Successfully deleted ${filePaths.length} clone voice files for user ${userId}`);
          }
        } else if (listError) {
          console.warn(`Failed to list clone voice files for user ${userId}: ${listError.message}`);
        } else {
          console.log(`No clone voice files found for user ${userId}`);
        }
      } catch (error: any) {
        console.warn(`Error cleaning up clone voice files for user ${userId}: ${error.message}`);
      }
    }
  } catch (error: any) {
    console.warn(`Error cleaning up custom clone voice ${voiceId}: ${error.message}`);
  }
}

async function callGenerateAudio(
  prompt: string,
  voice: string,
  language: string,
  speed: number,
  model_version: 'v7' | 'clone' | 'lemonfox' | 'speechify' | 'elevenlabs',
  clone_voice_name?: string,
  clone_voice_url?: string,
  clone_language?: string,
  elevenlabs_model_id?: string,
): Promise<{ audio_base64?: string; tokens: number }> {

  if (model_version === 'elevenlabs') {
    return await callElevenLabsTts({
      apiKey: elevenLabsApiKey,
      voiceId: voice,
      modelId: elevenlabs_model_id || DEFAULT_ELEVENLABS_MODEL_ID,
      text: prompt,
      speed,
    });
  } else if (model_version === 'clone') {
    // All clone voices (both predefined and custom) use Inworld API (v7)
    if (!inworldApiKey) {
      throw new Error('INWORLD_API_KEY is not set for clone voice');
    }

    const clampedSpeed = Math.max(0.5, Math.min(1.5, speed));
    const url = 'https://api.inworld.ai/tts/v1/voice';
    
    // UPDATED: Handle both predefined and custom clone voices correctly
    let voiceId: string;
    if (voice.includes('__')) {
      // This is already a workspace voice (predefined or custom)
      voiceId = normalizeVoiceId(voice);
    } else {
      // This is just a voice name - check if it's predefined
      const predefinedVoice = predefinedCloneVoices.find(v => v.name === voice);
      if (predefinedVoice) {
        voiceId = normalizeVoiceId(predefinedVoice.voice_id);
      } else {
        // Custom voice - assume workspace format needed
        voiceId = normalizeVoiceId(`default-ujsa1wysgyitfqg3ixpqka__${voice}`);
      }
    }
    
    const data = {
      text: prompt,
      voiceId: voiceId,
      modelId: 'inworld-tts-1.5-mini',
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: clampedSpeed,
      },
    };

    console.log(`Using clone voice via Inworld: ${clone_voice_name || 'Unknown'} -> ${voiceId}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${inworldApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Inworld HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    if (!result.audioContent) {
      throw new Error('No audioContent in Inworld response');
    }

    const tokens = result.usage?.processedCharactersCount || prompt.length * 4;
    return { audio_base64: result.audioContent, tokens };
    
  } else if (model_version === 'lemonfox') {
    // Lemonfox TTS generation
    if (!lemonfoxApiKey) {
      throw new Error('LEMONFOX_API_KEY is not set for lemonfox model');
    }

    const clampedSpeed = Math.max(0.5, Math.min(4.0, speed));
    const url = 'https://eu-api.lemonfox.ai/v1/audio/speech';
    const data = {
      input: prompt,
      voice: voice,
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
    const audioBase64 = btoa(binary);

    const tokens = prompt.length * 2; // Lemonfox uses 2x tokens
    return { audio_base64: audioBase64, tokens };

  } else if (model_version === 'speechify') {
    // Speechify TTS generation
    if (!speechifyApiKey) {
      throw new Error('SPEECHIFY_API_KEY is not set for speechify model');
    }

    // Clamp speed to 0.5-1.5 range and convert to SSML percentage
    const clampedSpeed = Math.max(0.5, Math.min(1.5, speed));

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
      voice_id: voice,
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

    // Use actual billable count if available, otherwise estimate
    const actualChars = result.billable_characters_count || prompt.length;
    const tokens = actualChars * 8; // Speechify uses 8x tokens
    return { audio_base64: result.audio_data, tokens };
    
  } else if (model_version === 'v7') {
    // Inworld API
    if (!inworldApiKey) {
      throw new Error('INWORLD_API_KEY is not set for v7 model');
    }

    const clampedSpeed = Math.max(0.5, Math.min(1.5, speed));
    const url = 'https://api.inworld.ai/tts/v1/voice';
    const data = {
      text: prompt,
      voiceId: voice, // UPDATED: Use voice directly for regular v7 voices (no normalization)
      modelId: 'inworld-tts-1.5-mini',
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: clampedSpeed,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${inworldApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Inworld HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    if (!result.audioContent) {
      throw new Error('No audioContent in Inworld response');
    }

    const tokens = result.usage?.processedCharactersCount || prompt.length * 4;
    return { audio_base64: result.audioContent, tokens };
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function callVolumeBoostFunction(user_id: string, audio_file_path: string, volume_multiplier: number, model_version: string): Promise<boolean> {
  try {
    console.log(`Calling volume boost function for ${audio_file_path} with volume ${volume_multiplier}x`);
    
    const response = await fetch('https://us-central1-story-script-ai.cloudfunctions.net/boost-audio-volume', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
      },
      body: JSON.stringify({
        user_id,
        audio_file_path,
        volume_multiplier,
        model_version,
        is_single_file: true
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Volume boost failed: HTTP ${response.status}: ${errorText}`);
      return false;
    }

    const result = await response.json();
    console.log(`Volume boost result: ${result.status}`);
    return result.status === 'success';
  } catch (error: any) {
    console.error(`Error calling volume boost function: ${error.message}`);
    return false;
  }
}

serve(async (req: Request) => {
  const responseHeaders = { ...getCorsHeaders(req), 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 360000;

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: responseHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed', code: 405 }),
      { status: 405, headers: responseHeaders }
    );
  }

  let requestBody: any;
  try {
    requestBody = await req.json();
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body', code: 400 }),
      { status: 400, headers: responseHeaders }
    );
  }

  try {
    let { 
      user_id, 
      prompt, 
      group_id, 
      story_title, 
      voice, 
      language, 
      model_version, 
      speed, 
      preference = 'merged', 
      remove_title_chapters = false,
      volume = 1.0,
      tab = 1,  // Add tab parameter with default
      // Clone voice fields
      clone_voice_name,
      clone_voice_url,
      clone_language,
      // ElevenLabs fields
      elevenlabs_model_id,
    } = requestBody;

    if (!user_id || !prompt || !group_id || !story_title || !voice || !language || !model_version || speed === undefined) {
      await logError('Missing required fields', new Error('Invalid input'));
      return new Response(
        JSON.stringify({ error: 'Missing required fields: user_id, prompt, group_id, story_title, voice, language, model_version, or speed', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    if (!['v7', 'clone', 'lemonfox', 'speechify', 'elevenlabs'].includes(model_version)) {
      return new Response(
        JSON.stringify({ error: 'Invalid model_version', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    if (typeof speed !== 'number' || speed < 0.5 || (model_version === 'lemonfox' ? speed > 4.0 : speed > 2.0)) {
      return new Response(
        JSON.stringify({ error: 'Invalid speed', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    if (typeof volume !== 'number' || volume < 1.0 || volume > 10.0) {
      return new Response(
        JSON.stringify({ error: 'Invalid volume range (1.0-10.0)', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    if (!['merged', 'separate'].includes(preference)) {
      return new Response(
        JSON.stringify({ error: 'Invalid preference', code: 400 }),
        { status: 400, headers: responseHeaders }
      );
    }

    // UPDATED: Handle voice selection for clone voices
    let actualVoice = voice;
    let actualCloneVoiceName = clone_voice_name;
    let actualCloneVoiceUrl = clone_voice_url;
    let actualCloneLanguage = clone_language;

    // Check if this is a clone voice and extract the actual voice ID
    if (model_version === 'clone' && voice.startsWith('clone:')) {
      const voiceIdentifier = voice.replace('clone:', '');
      
      // Check if it's a predefined clone voice
      const predefinedVoice = predefinedCloneVoices.find(v => v.name === voiceIdentifier);
      if (predefinedVoice) {
        // It's a predefined clone voice
        actualVoice = predefinedVoice.voice_id;
        actualCloneVoiceName = predefinedVoice.name;
        actualCloneVoiceUrl = predefinedVoice.voice_id;
        actualCloneLanguage = 'english';
      } else {
        // It's a custom clone voice - voiceIdentifier should be the actual voice ID from Inworld
        actualVoice = voiceIdentifier;
        actualCloneVoiceUrl = voiceIdentifier;
        // Keep the provided clone_voice_name and clone_language for custom voices
      }
    }

    if (remove_title_chapters) {
      prompt = cleanText(prompt);
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 401 }),
        { status: 401, headers: responseHeaders }
      );
    }
    const finalUserId = auth.isServiceRole ? user_id : auth.userId;

    const { data: planData, error: planError } = await supabase
      .from('user_plans')
      .select('plan_type, tokens_used, rollover_tokens, is_legacy_plan')
      .eq('user_id', finalUserId)
      .eq('is_active', true)
      .single();

    if (planError || !planData) {
      await logError('Plan query error', planError || new Error('No plan data'));
      return new Response(
        JSON.stringify({ error: `Failed to fetch user plan for user_id: ${finalUserId}. Ensure a valid plan exists.`, code: 403 }),
        { status: 403, headers: responseHeaders }
      );
    }

    const planType = planData.plan_type || 'free';
    // Honour is_legacy_plan so new users get their (larger) NEW allotment.
    const isLegacy = (planData as { is_legacy_plan?: boolean }).is_legacy_plan !== false;
    const tokensRemaining = planMaxTokensForUser(planType, isLegacy) - (planData.tokens_used || 0) + (planData.rollover_tokens || 0);
    
    // Calculate required tokens based on model version
    let tokenMultiplier = 1;
    if (model_version === 'clone') {
      tokenMultiplier = 4;
    } else if (model_version === 'v7') {
      tokenMultiplier = 4;
    } else if (model_version === 'lemonfox') {
      tokenMultiplier = 2;
    } else if (model_version === 'speechify') {
      tokenMultiplier = 8;
    } else if (model_version === 'elevenlabs') {
      tokenMultiplier = elevenLabsTokensPerChar(elevenlabs_model_id);
    }
    
    const requiredTokens = prompt.length * tokenMultiplier;

    // Add volume boost tokens if volume > 1.0 (100 tokens for single file boost)
    const volumeBoostTokens = volume > 1.0 ? 100 : 0;
    const totalRequiredTokens = requiredTokens + volumeBoostTokens;

    if (tokensRemaining < totalRequiredTokens) {
      await logError('Insufficient tokens', new Error(`Required: ${totalRequiredTokens}, Available: ${tokensRemaining}`));
      return new Response(
        JSON.stringify({
          error: `Insufficient tokens for single audio generation. Required: ${totalRequiredTokens}, Available: ${tokensRemaining}`,
          code: 403
        }),
        { status: 403, headers: responseHeaders }
      );
    }

    const folderTimestamp = new Date().toISOString().replace(/[-:T.]/g, '');
    const sanitizedTitle = story_title.replace(/[^a-zA-Z0-9\s-]/g, '.').toLowerCase().trim().replace(/\s+/g, '-');
    const audioFolder = `documents/${finalUserId}/${group_id}/${sanitizedTitle}_${folderTimestamp}`;
    
    const ext = 'mp3';
    const audioPath = `${audioFolder}/1.${ext}`;

    const taskData = {
      user_id: finalUserId,
      group_id,
      story_title,
      description: '',
      text_part: prompt,
      total_batches: 1,
      batch_number: 1,
      total_prompts: 1,
      status: 'running',
      progress: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      single_audio: true,
      folder_timestamp: folderTimestamp,
      tokens: 0,
      token_updated: false,
      settings: { voice: actualVoice, language, speed, preference, volume }, // Use actual voice
      model_version,
      voice: actualVoice, // Use actual voice
      language,
      speed,
      preference,
      version: 0,
      is_corrected: false,
      remove_title_chapters,
      variant: 0,
      volume,
      tab,  // Add tab parameter
      // Clone voice fields
      is_clone_voice: model_version === 'clone',
      clone_voice_name: actualCloneVoiceName,
      clone_voice_url: actualCloneVoiceUrl,
      clone_language: actualCloneLanguage,
    };

    const { data: task, error: taskInsertError } = await supabase
      .from('audio_tasks')
      .insert(taskData)
      .select()
      .single();

    if (taskInsertError || !task) {
      await logError('Task insert error', taskInsertError || new Error('No task data'));
      return new Response(
        JSON.stringify({ error: `Failed to create single audio task: ${taskInsertError?.message || 'Unknown error'}`, code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    let audio_base64: string | undefined;
    let tokens: number;
    let audioData: ArrayBuffer;
    let attempt = 0;
    const maxAttempts = 3;

    while (attempt < maxAttempts) {
      try {
        const audioResult = await callGenerateAudio(
          prompt, 
          actualVoice, // Use actual voice
          language, 
          speed, 
          model_version,
          actualCloneVoiceName,
          actualCloneVoiceUrl,
          actualCloneLanguage,
          elevenlabs_model_id,
        );
        audio_base64 = audioResult.audio_base64;
        tokens = audioResult.tokens;
      } catch (error) {
        await logError('Audio generation error', error);
        await supabase
          .from('audio_tasks')
          .update({
            status: 'error',
            error: `Audio generation failed: ${error.message}`,
            updated_at: new Date().toISOString(),
            tokens: 0,
            token_updated: false
          })
          .eq('id', task.id);
        throw error;
      }

      try {
        // Handle base64 audio for all models (v7, lemonfox, speechify, clone)
        if (!audio_base64) throw new Error(`Missing audio_base64 for ${model_version}`);
        audioData = base64ToArrayBuffer(audio_base64);

        if (audioData.byteLength <= 100 && attempt < maxAttempts - 1) {
          await logError('Small audio file detected', new Error('Audio file is <= 100 bytes'));
          attempt++;
          continue;
        } else if (audioData.byteLength <= 100) {
          await logError('Redone audio is still small', new Error('Audio file is <= 100 bytes after redo'));
          await supabase
            .from('audio_tasks')
            .update({
              status: 'error',
              error: 'Redone audio is still small',
              updated_at: new Date().toISOString(),
              tokens: 0,
              token_updated: false
            })
            .eq('id', task.id);
          throw new Error('Redone audio is still small');
        }
        break;
      } catch (error) {
        if (error.name === 'AbortError') {
          error = new Error('Audio download timed out');
        }
        await logError('Audio download error', error);
        await supabase
          .from('audio_tasks')
          .update({
            status: 'error',
            error: `Failed to download audio: ${error.message}`,
            updated_at: new Date().toISOString(),
            tokens: 0,
            token_updated: false
          })
          .eq('id', task.id);
        throw error;
      }
    }

    try {
      const { error: uploadError } = await supabase.storage
        .from('stories')
        .upload(audioPath, audioData, { contentType: `audio/${ext}` });
      if (uploadError) throw uploadError;
    } catch (error) {
      await logError('Audio upload error', error);
      await supabase
        .from('audio_tasks')
        .update({
          status: 'error',
          error: `Failed to upload audio: ${error.message}`,
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw error;
    }

    // Apply volume boost if volume > 1.0
    let volumeBoostSuccess = true;
    let actualTokensUsed = tokens;
    
    if (volume > 1.0) {
      console.log(`Applying volume boost of ${volume}x to ${audioPath}`);
      volumeBoostSuccess = await callVolumeBoostFunction(finalUserId, audioPath, volume, model_version);
      
      if (volumeBoostSuccess) {
        actualTokensUsed += volumeBoostTokens;
        console.log(`Volume boost successful, added ${volumeBoostTokens} tokens`);
      } else {
        console.warn('Volume boost failed, but continuing with original audio');
        // Don't fail the entire process, just log the warning
      }
    }

    const { data: urlData } = supabase.storage.from('stories').getPublicUrl(audioPath);
    if (!urlData?.publicUrl) {
      await logError('Public URL error', new Error('No public URL'));
      await supabase
        .from('audio_tasks')
        .update({
          status: 'error',
          error: 'Failed to retrieve public URL',
          updated_at: new Date().toISOString(),
          tokens: 0,
          token_updated: false
        })
        .eq('id', task.id);
      throw new Error('Failed to retrieve public URL');
    }

    const batchContent = `Audio 1 saved to: ${urlData.publicUrl}${volume > 1.0 ? ` (Volume boosted ${volume}x${volumeBoostSuccess ? '' : ' - boost failed'})` : ''}`;

    const { error: finalUpdateError } = await supabase
      .from('audio_tasks')
      .update({
        status: 'completed_final',
        batch_output: batchContent,
        progress: 100,
        tokens: actualTokensUsed,
        token_updated: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    if (finalUpdateError) {
      await logError('Final task update error', finalUpdateError);
      return new Response(
        JSON.stringify({ error: `Failed to update task after audio generation: ${finalUpdateError.message}`, code: 500 }),
        { status: 500, headers: responseHeaders }
      );
    }

    // UPDATED: Clean up custom clone voice after successful audio generation with comprehensive cleanup
    if (model_version === 'clone' && actualCloneVoiceUrl && isCustomCloneVoice(actualCloneVoiceUrl)) {
      console.log(`Detected custom clone voice usage: ${actualCloneVoiceUrl}, cleaning up...`);
      
      // UPDATED: Get audio file path for cleanup - try to find the uploaded audio file path
      let audioFilePath = null;
      
      // Try to get the audio file path from the batch_output
      // This will help us locate the original uploaded clone voice audio file
      try {
        const audioUrl = batchContent.match(/https:\/\/[^\s]+/)?.[0];
        if (audioUrl) {
          // The clone voice audio file would be in the audio bucket, not stories bucket
          // We'll pass the URL and let manage-clone-voice handle the path extraction
          audioFilePath = audioUrl;
        }
      } catch (error: any) {
        console.warn(`Could not retrieve audio file path for cleanup: ${error.message}`);
      }

      await cleanupCustomCloneVoice(actualCloneVoiceUrl, finalUserId, audioFilePath);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);

    return new Response(
      JSON.stringify({ 
        message: 'Single audio generation completed', 
        group_id, 
        audio_url: urlData.publicUrl, 
        tokens: actualTokensUsed,
        volume_boost_applied: volume > 1.0,
        volume_boost_success: volumeBoostSuccess
      }),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    await logError('Error in single-audio', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error', code: 500 }),
      { status: 500, headers: responseHeaders }
    );
  }
});



