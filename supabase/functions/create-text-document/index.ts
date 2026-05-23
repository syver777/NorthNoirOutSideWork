import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.75.1';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

interface CreateTextDocumentRequest {
  user_id: string;
  text_content: string;
  voice: string;
  language: string;
  model_version: 'v7' | 'lemonfox' | 'speechify' | 'clone';
  speed: number;
  volume: number;
  group_id: string;
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
}

function calculateWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body: CreateTextDocumentRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      body.user_id = auth.userId;
    }
    const {
      user_id,
      text_content,
      voice,
      language,
      model_version,
      speed,
      volume,
      group_id,
      clone_voice_name,
      clone_voice_url,
      clone_language
    } = body;

    // Validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Invalid user_id');
    if (!text_content || text_content.length === 0) throw new Error('Text content is required');
    if (text_content.length > 700000) throw new Error('Text content exceeds 700,000 character limit');
    if (!voice) throw new Error('Voice is required');
    if (!language) throw new Error('Language is required');
    if (!['v7', 'lemonfox', 'speechify', 'clone'].includes(model_version)) throw new Error('Invalid model_version');
    if (!group_id || !uuidRegex.test(group_id)) throw new Error('Invalid group_id');

    // Create document file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `individual_audio_${timestamp}.txt`;
    const filePath = `documents/${user_id}/${group_id}/${fileName}`;

    // Upload text content to storage
    const { error: uploadError } = await supabase.storage
      .from('stories')
      .upload(filePath, text_content, {
        contentType: 'text/plain',
        upsert: true,
      });

    if (uploadError) throw new Error(`Failed to upload text content: ${uploadError.message}`);

    // Create document metadata
    const docId = crypto.randomUUID();
    const wordCount = calculateWordCount(text_content);

    const { error: insertError } = await supabase
      .from('story_documents')
      .insert({
        id: docId,
        user_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        file_path: filePath,
        title: 'Individual Audio Text',
        description: 'Document created from individual audio text input',
        word_count: wordCount,
        version: 1,
        is_corrected: false,
        is_prompted: false,
        group_id,
        variant: 1,
        file_size: text_content.length,
      });

    if (insertError) {
      // Cleanup uploaded file if document creation fails
      await supabase.storage.from('stories').remove([filePath]);
      throw new Error(`Failed to create document: ${insertError.message}`);
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
      const predefinedCloneVoices = [
        { name: "Declan", voice_id: "default-ujsa1wysgyitfqg3ixpqka__declan" },
        { name: "Adrian", voice_id: "default-ujsa1wysgyitfqg3ixpqka__adrian" },
        { name: "Alfred", voice_id: "default-ujsa1wysgyitfqg3ixpqka__alfred" },
        { name: "Conrad", voice_id: "default-ujsa1wysgyitfqg3ixpqka__conrad" },
        { name: "Hugo", voice_id: "default-ujsa1wysgyitfqg3ixpqka__hugo" },
        { name: "Ryder", voice_id: "default-ujsa1wysgyitfqg3ixpqka__ryder" },
        { name: "Victor", voice_id: "default-ujsa1wysgyitfqg3ixpqka__victor" }
      ];

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

    // Call setup-audio-tasks
    const setupPayload: any = {
      user_id,
      group_id,
      file_path: filePath,
      story_title: 'Individual Audio Text',
      description: 'Document created from individual audio text input',
      doc_id: docId,
      variant: 1,
      voice: actualVoice, // Use actual voice ID
      language,
      model_version,
      speed,
      volume,
      preference: 'separate',
      remove_title_chapters: false,
      single_audio: true, // Mark as single audio
    };

    // Add clone voice fields if model_version is 'clone'
    if (model_version === 'clone') {
      setupPayload.clone_voice_name = actualCloneVoiceName;
      setupPayload.clone_voice_url = actualCloneVoiceUrl;
      setupPayload.clone_language = actualCloneLanguage;
    }

    const setupResponse = await fetch(`${supabaseUrl}/functions/v1/setup-audio-tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify(setupPayload),
    });

    if (!setupResponse.ok) {
      const errorData = await setupResponse.json();
      throw new Error(`Setup audio tasks failed: ${errorData.error}`);
    }

    const setupData = await setupResponse.json();

    return new Response(
      JSON.stringify({
        doc_id: docId,
        group_id,
        file_path: filePath,
        total_batches: setupData.total_batches,
        tokens: setupData.tokens,
      }),
      { status: 200, headers: responseHeaders }
    );

  } catch (error: any) {
    console.error('Error in create-text-document:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders }
    );
  }
});



