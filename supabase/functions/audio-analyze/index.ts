import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { elevenLabsTokensPerChar } from '../_shared/elevenlabs.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
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

interface AnalyzeRequest {
  user_id: string;
  file_path?: string;
  doc_id?: string;
  story_title: string;
  description?: string;
  content?: string;
  voice: string;
  remove_title_chapters: boolean;
  volume?: number;
  /** Required for `voice` strings starting with `elevenlabs:`. */
  elevenlabs_model_id?: string;
}

const premiumVoices = [
  'Alex', 'Ashley', 'Craig', 'Deborah', 'Dennis', 'Edward', 'Elizabeth', 'Hades',
  'Julia', 'Pixie', 'Mark', 'Olivia', 'Priya', 'Ronald', 'Sarah', 'Shaun',
  'Theodore', 'Timothy', 'Wendy', 'Dominus', 'Hana', 'Clive', 'Carter', 'Blake', 'Luna',
  'Yichen', 'Xiaoyin', 'Xinyi', 'Jing', 'Erik', 'Katrien', 'Lennart', 'Lore', 
  'Alain', 'Hélène', 'Mathieu', 'Étienne', 'Johanna', 'Josef', 'Gianni', 'Orietta', 
  'Asuka', 'Satoshi', 'Hyunwoo', 'Minji', 'Seojun', 'Yoona', 'Szymon', 'Wojciech', 
  'Heitor', 'Maitê', 'Diego', 'Lupita', 'Miguel', 'Rafael', 'Svetlana', 'Elena', 
  'Dmitry', 'Nikolai', 'Riya'
];

const cloneVoices = [
  'Declan', 'Adrian', 'Alfred', 'Conrad', 'Hugo', 'Ryder', 'Victor', 'custom'
];

const coreVoices = [
  'heart', 'bella', 'michael', 'alloy', 'aoede', 'kore', 'jessica', 'nicole',
  'nova', 'river', 'sarah', 'sky', 'echo', 'eric', 'fenrir', 'liam', 'onyx',
  'puck', 'adam', 'santa', 'alice', 'emma', 'isabella', 'lily', 'daniel',
  'fable', 'george', 'lewis'
];

const apexVoices = [
  'oliver', 'erin', 'rob', 'jesse', 'ken', 'lindsey', 'monica', 'stacy', 'james',
  'christina', 'douglas', 'patricia', 'peter', 'jeremy', 'barbara', 'donald',
  'paul', 'timothy', 'dorothy', 'gary', 'cynthia', 'belinda', 'dylan', 'hugo',
  'kurt', 'sherman', 'allan', 'jacquelin', 'glenda', 'sherrie', 'becky', 'jenna',
  'faye', 'jaclyn', 'meredith', 'melinda', 'isabel', 'rubye', 'janelle',
  'constance', 'deanna', 'josie', 'ronda', 'alton', 'cesar', 'grant', 'lionel',
  'wilbur', 'lester', 'matt', 'lyle', 'hubert', 'kenny', 'doug', 'woodrow',
  'marco', 'rufus', 'abraham', 'irving', 'julius', 'benjamin', 'ron', 'phil',
  'collin', 'helen', 'carol', 'harvey', 'gordon', 'wilma', 'wanda', 'linda',
  'kim', 'juan-pablo', 'gael', 'valeria', 'emmanuel', 'jose-manuel', 'lizbeth',
  'romina', 'rafael', 'matias', 'juan-carlos', 'fernando', 'daniela',
  'jose-angel', 'mariana', 'carolina', 'emiliano', 'jesus', 'angel', 'aitana',
  'maximiliano', 'estefania', 'yamileth', 'jimena', 'luciana', 'ivanna',
  'jose-luis', 'miguel-angel', 'luis-angel', 'julieta', 'alejandra',
  'esmeralda', 'alondra', 'alexa', 'danna-sofia', 'celia', 'carlos', 'carmen',
  'alejandro', 'heidi-speechify', 'anni', 'luca', 'anton', 'gabriel-de', 'nico',
  'mathilda', 'philipp', 'merle', 'moritz', 'melina', 'thea', 'nele', 'jasper',
  'louis', 'ben', 'oskar', 'ronja', 'pepe', 'amalia', 'matteo', 'juna', 'lina',
  'greta', 'elina', 'linus', 'jonathan-de', 'mila', 'ella', 'pia', 'maximilian',
  'milan', 'amelie', 'luisa', 'jannik', 'hannes', 'andra', 'frederick',
  'angele', 'adeline', 'anais', 'angelique', 'eliane', 'jules', 'sacha',
  'gabin', 'marius', 'clement', 'nael', 'mael', 'agathe', 'evelyne', 'carine',
  'delphine', 'estelle', 'eugenie', 'eden', 'rayan', 'mathis', 'tiago',
  'ibrahim', 'elisabeth', 'maxime', 'ayden', 'lenny', 'alexandre', 'amir',
  'imran', 'cecile', 'christelle', 'dominique', 'nino', 'aline', 'augustine',
  'kylian', 'aurelie', 'emilie', 'enzo', 'noe', 'camille', 'claudine',
  'valentin', 'elise', 'raphael'
];

function calculateWordCount(content: string): number {
  return content.trim().split(/\s+/).filter(word => word.length > 0).length;
}

function calculateCharacterCount(content: string): number {
  return content.length;
}

function removeTitleAndChapters(content: string): string {
  // Remove title at the beginning (first line if it looks like a title)
  let lines = content.split('\n');
  
  // Remove first line if it's likely a title (short line, no periods, capitalized)
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 0 && firstLine.length < 100 && !firstLine.includes('.') && firstLine === firstLine.toUpperCase()) {
      lines = lines.slice(1);
    }
  }
  
  // Remove chapter headings (lines that start with "Chapter" or are all caps and short)
  lines = lines.filter(line => {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) return true; // Keep empty lines
    if (trimmedLine.length > 100) return true; // Keep long lines (likely not headings)
    
    // Remove lines that start with "Chapter"
    if (/^Chapter\s+/i.test(trimmedLine)) return false;
    
    // Remove lines that are all caps and relatively short (likely headings)
    if (trimmedLine === trimmedLine.toUpperCase() && trimmedLine.length < 50 && !/[.!?]/.test(trimmedLine)) {
      return false;
    }
    
    return true;
  });
  
  return lines.join('\n');
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

    const requestData: AnalyzeRequest = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      requestData.user_id = auth.userId;
    }
    const { user_id, file_path, doc_id, story_title, description, content: providedContent, voice, remove_title_chapters, volume = 1.0, elevenlabs_model_id } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!voice || typeof voice !== 'string') throw new Error('Missing or invalid voice');

    let content: string;

    if (providedContent) {
      // Content provided directly (uploaded file)
      content = providedContent;
    } else {
      // Download from storage
      if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
      if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');

      const { data: docData, error: docError } = await supabase
        .from('story_documents')
        .select('version, description')
        .eq('id', doc_id)
        .single();
      if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);
      if (![1, 2].includes(docData.version)) throw new Error('Document version must be 1 or 2');

      const { data: fileData, error: fileError } = await supabase
        .storage
        .from('stories')
        .download(file_path);
      if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);

      content = await fileData.text();
    }

    if (!content || content.length === 0) throw new Error('Document content is empty');

    // Apply title and chapter removal if requested and applicable
    let processedContent = content;
    if (remove_title_chapters) {
      // Only apply if it's a Story Script AI document (has description) or if it's an uploaded file
      if (providedContent || (description && description !== 'Uploaded document for image prompt generation')) {
        processedContent = removeTitleAndChapters(content);
      }
    }

    const totalCharacters = calculateCharacterCount(processedContent);
    const wordCount = calculateWordCount(processedContent);
    
    // Extract voice type and name from the voice parameter
    const voiceType = voice.includes(':') ? voice.split(':')[0] : 'core';
    const voiceName = voice.includes(':') ? voice.split(':')[1] : voice;

    // Determine voice type and cost based on prefix
    let costPerChar: number;
    if (voiceType === 'elevenlabs') {
      costPerChar = elevenLabsTokensPerChar(elevenlabs_model_id);
    } else if (voiceType === 'premium') {
      costPerChar = 4; // Premium voices: 4 tokens per character
    } else if (voiceType === 'clone') {
      costPerChar = 4; // Clone voices: 4 tokens per character (updated from 2 to 4)
    } else if (voiceType === 'core') {
      costPerChar = 2; // Core voices: 2 tokens per character
    } else if (voiceType === 'apex') {
      costPerChar = 8; // Apex voices: 8 tokens per character
    } else {
      costPerChar = 2; // Default to core rate: 2 tokens per character
    }
    
    const baseTokens = totalCharacters * costPerChar;
    const volumeBoost = (volume && volume > 1.0) ? 100 : 0; // Updated to use flat 100 tokens for volume boost
    const estimatedTokens = baseTokens + volumeBoost;
    
    // Estimate file size: base 1000 words = 15MB
    const baseSizePer1000Words = 15;
    let multiplier = 1;
    if (voiceType === 'clone') {
        multiplier = 6; // Clone voices have larger file sizes
    } else if (voiceType === 'premium') {
        multiplier = 0.5; // Premium voices have smaller file sizes
    } else if (voiceType === 'core') {
        multiplier = 6; // Core voices have the same audio size as clone voices
    } else if (voiceType === 'apex') {
        multiplier = 0.5; // Apex voices have smaller file sizes
    } else if (voiceType === 'elevenlabs') {
        multiplier = 0.5; // ElevenLabs MP3 ~similar to Apex/Premium
    }
    const estimatedFileSizeMB = Math.ceil((wordCount / 1000) * baseSizePer1000Words * multiplier);

    if (Date.now() - startTime > maxRuntime) throw new Error('Function timed out');

    // Build response object conditionally
    const response: any = {
      totalCharacters,
      wordCount,
      estimatedTokens,
      estimatedFileSizeMB,
      isPremiumVoice: voiceType !== 'core', // Return true for premium, clone, and apex voices
      costPerChar,
    };

    // Only include volumeBoost if volume > 1.0
    if (volume && volume > 1.0) {
      response.volumeBoost = volumeBoost;
    }

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    await logError('Error in audio-analyze', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});



