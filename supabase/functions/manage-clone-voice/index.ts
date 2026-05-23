import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.75.1';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const inworldApiKey = Deno.env.get('INWORLD_API_KEY') ?? '';
const workspaceId = Deno.env.get('INWORLD_WORKSPACE_ID') ?? 'default-ujsa1wysgyitfqg3ixpqka';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

if (!inworldApiKey) {
  throw new Error('INWORLD_API_KEY is not set');
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

interface CloneVoiceRequest {
  action: 'create' | 'delete';
  voice_name?: string;
  language?: string;
  audio_data?: string; // base64 encoded audio
  voice_id?: string; // for deletion
  audio_file_path?: string; // for deletion
}

// UPDATED: List of supported languages for validation
const SUPPORTED_LANGUAGES = [
  'english', 'chinese', 'korean', 'japanese', 'russian', 'auto', 
  'italian', 'spanish', 'portuguese', 'german', 'french', 
  'arabic', 'polish', 'dutch', 'hindi', 'hebrew'
];

function validateInputs(data: CloneVoiceRequest): string | null {
  if (!data.action || !['create', 'delete'].includes(data.action)) {
    return 'Invalid or missing action. Must be "create" or "delete"';
  }

  if (data.action === 'create') {
    if (!data.voice_name || typeof data.voice_name !== 'string') {
      return 'Missing or invalid voice_name for create action';
    }
    if (!data.language || typeof data.language !== 'string') {
      return 'Missing or invalid language for create action';
    }
    // ADDED: Validate that language is supported
    if (!SUPPORTED_LANGUAGES.includes(data.language.toLowerCase())) {
      return `Unsupported language: ${data.language}. Supported languages are: ${SUPPORTED_LANGUAGES.join(', ')}`;
    }
    if (!data.audio_data || typeof data.audio_data !== 'string') {
      return 'Missing or invalid audio_data for create action';
    }
  }

  if (data.action === 'delete') {
    if (!data.voice_id || typeof data.voice_id !== 'string') {
      return 'Missing or invalid voice_id for delete action';
    }
  }

  return null;
}

// UPDATED: Expanded language mapping to include all supported languages
function mapLanguageToInworldCode(language: string): string {
  const languageMap: Record<string, string> = {
    'english': 'EN_US',
    'chinese': 'ZH_CN',
    'korean': 'KO_KR',
    'japanese': 'JA_JP',
    'russian': 'RU_RU',
    'auto': 'AUTO',
    'italian': 'IT_IT',
    'spanish': 'ES_ES',
    'portuguese': 'PT_BR',
    'german': 'DE_DE',
    'french': 'FR_FR',
    'arabic': 'AR_SA',
    'polish': 'PL_PL',
    'dutch': 'NL_NL',
    'hindi': 'HI_IN',
    'hebrew': 'HE_IL'
  };

  const code = languageMap[language.toLowerCase()];
  if (!code) {
    console.warn(`Unknown language: ${language}, defaulting to EN_US`);
    return 'EN_US';
  }
  return code;
}

// UPDATED: Sanitize voice name for Inworld API (remove special characters, convert to lowercase)
function sanitizeVoiceNameForInworld(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
    .slice(0, 20); // Limit to 20 characters
}

async function createCloneVoice(voiceName: string, language: string, audioData: string): Promise<{ voiceId: string; displayName: string; warnings?: string[] }> {
  const url = `https://api.inworld.ai/voices/v1/workspaces/${workspaceId}/voices:clone`;
  
  const headers = {
    'Authorization': `Basic ${inworldApiKey}`,
    'Content-Type': 'application/json'
  };

  const langCode = mapLanguageToInworldCode(language);
  
  // UPDATED: Use sanitized voice name for Inworld API
  const sanitizedVoiceName = sanitizeVoiceNameForInworld(voiceName);

  const data = {
    displayName: sanitizedVoiceName,
    langCode: langCode,
    voiceSamples: [
      {
        audioData: audioData
      }
    ],
    description: `Custom cloned voice: ${voiceName}`,
    audioProcessingConfig: {
      removeBackgroundNoise: true
    }
  };

  console.log(`Language: ${language} -> ${langCode}`);
  console.log(`Request URL: ${url}`);
  console.log(`Creating voice with sanitized name: ${sanitizedVoiceName} (original: ${voiceName})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to clone voice: HTTP ${response.status}: ${errorText}`);
  }

  const result = await response.json();

  if (!result.voice || !result.voice.voiceId) {
    throw new Error(`Invalid response format: ${JSON.stringify(result)}`);
  }

  const warnings: string[] = [];
  if (result.audioSamplesValidated) {
    for (const sample of result.audioSamplesValidated) {
      if (sample.warnings && sample.warnings.length > 0) {
        warnings.push(...sample.warnings.map((w: any) => w.text || 'Unknown warning'));
      }
    }
  }

  console.log(`Voice created successfully. Actual voice ID: ${result.voice.voiceId}`);

  return {
    voiceId: result.voice.voiceId,
    displayName: sanitizedVoiceName, // Return the sanitized name used
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

async function deleteCloneVoice(voiceId: string): Promise<void> {
  if (!voiceId.includes('__')) {
    throw new Error('Invalid voice ID format');
  }

  // Extract voice name from voice_id (format: workspace__voicename)
  const voiceName = voiceId.split('__').pop();
  if (!voiceName) {
    throw new Error('Could not extract voice name from voice ID');
  }

  const url = `https://api.inworld.ai/voices/v1/workspaces/${workspaceId}/voices/${voiceName}`;
  
  const headers = {
    'Authorization': `Basic ${inworldApiKey}`
  };

  console.log(`Deleting voice: ${voiceName} from voice ID: ${voiceId}`);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: headers
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to delete voice: HTTP ${response.status}: ${errorText}`);
  }

  console.log(`Voice deleted successfully: ${voiceName}`);
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

    const payload: CloneVoiceRequest = await req.json();
    const validationError = validateInputs(payload);
    if (validationError) return new Response(JSON.stringify({ error: validationError, code: 400 }), { status: 400, headers: responseHeaders });

    if (payload.action === 'create') {
      console.log(`Creating clone voice: ${payload.voice_name} (${payload.language})`);
      
      const result = await createCloneVoice(payload.voice_name!, payload.language!, payload.audio_data!);
      
      // Wait for voice to be processed
      console.log('Waiting 30 seconds for voice to be fully processed...');
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      return new Response(JSON.stringify({
        success: true,
        voiceId: result.voiceId, // Return actual voice ID from Inworld
        voiceName: payload.voice_name, // Return original voice name for display
        displayName: result.displayName, // Return sanitized name used in Inworld
        language: payload.language,
        warnings: result.warnings
      }), { status: 200, headers: responseHeaders });

    } else if (payload.action === 'delete') {
      console.log(`Deleting clone voice: ${payload.voice_id}`);
      
      // Delete from Inworld workspace
      await deleteCloneVoice(payload.voice_id!);
      
      // UPDATED: Delete audio file from Supabase storage if path provided
      if (payload.audio_file_path) {
        console.log(`Deleting audio file: ${payload.audio_file_path}`);
        try {
          // FIXED: Extract correct file path from full URL or use as-is if it's already a path
          let filePath = payload.audio_file_path;
          
          // If it's a full URL, extract the path part after /audio/
          if (filePath.includes('/storage/v1/object/public/audio/')) {
            filePath = filePath.split('/storage/v1/object/public/audio/')[1];
          } else if (filePath.includes('https://')) {
            // Handle other URL formats - extract everything after the last /audio/
            const audioIndex = filePath.lastIndexOf('/audio/');
            if (audioIndex !== -1) {
              filePath = filePath.substring(audioIndex + 7); // Remove '/audio/' part
            }
          }
          // If filePath doesn't contain https://, assume it's already a proper path
          
          console.log(`Attempting to delete file path: ${filePath}`);
          
          const { error: storageError } = await supabase.storage
            .from('audio')
            .remove([filePath]);
          
          if (storageError) {
            console.warn(`Failed to delete audio file: ${storageError.message}`);
            // Don't throw error, just warn - voice deletion from Inworld is more important
          } else {
            console.log('Audio file deleted successfully from storage');
          }
        } catch (error: any) {
          console.warn(`Error deleting audio file: ${error.message}`);
          // Don't throw error, just warn
        }
      }
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Voice and audio file deleted successfully'
      }), { status: 200, headers: responseHeaders });
    }

  } catch (error: any) {
    await logError('Error in manage-clone-voice', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



