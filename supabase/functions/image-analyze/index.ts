import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

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
  file_path: string;
  doc_id: string;
  story_title: string;
  description: string;
}

interface Prompt {
  text: string;
  index: number;
}

function extractImagePrompts(content: string): Prompt[] {
  const prompts: Prompt[] = [];
  const startMarker = '[Image Prompt:';
  const endMarker = ']';
  let currentPos = 0;
  let index = 1;

  while (true) {
    const startIndex = content.indexOf(startMarker, currentPos);
    if (startIndex === -1) break;
    const endIndex = content.indexOf(endMarker, startIndex + startMarker.length);
    if (endIndex === -1) break;
    const promptText = content.slice(startIndex + startMarker.length, endIndex).trim();
    if (promptText.length > 0) {
      prompts.push({ text: promptText, index });
      index++;
    }
    currentPos = endIndex + endMarker.length;
  }
  return prompts;
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
    const { user_id, file_path, doc_id, story_title, description } = requestData;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!user_id || !uuidRegex.test(user_id)) throw new Error('Missing or invalid user_id');
    if (!doc_id || !uuidRegex.test(doc_id)) throw new Error('Missing or invalid doc_id');
    if (!file_path || typeof file_path !== 'string') throw new Error('Missing or invalid file_path');
    if (!story_title || typeof story_title !== 'string') throw new Error('Missing or invalid story_title');
    if (!description || typeof description !== 'string') throw new Error('Missing or invalid description');

    const { data: docData, error: docError } = await supabase
      .from('story_documents')
      .select('version')
      .eq('id', doc_id)
      .single();
    if (docError) throw new Error(`Failed to fetch document metadata: ${docError.message}`);
    if (![3, 4].includes(docData.version)) throw new Error('Document version must be 3 or 4');

    const { data: fileData, error: fileError } = await supabase
      .storage
      .from('stories')
      .download(file_path);
    if (fileError) throw new Error(`Failed to download document: ${fileError.message}`);

    const content = await fileData.text();
    if (!content || content.length === 0) throw new Error('Document content is empty');

    const prompts = extractImagePrompts(content);
    if (prompts.length === 0) throw new Error('No image prompts found in the document');

    const totalImages = prompts.length;
    const estimatedTokens = totalImages * 42000;

    if (Date.now() - startTime > maxRuntime) throw new Error('Function timed out');

    return new Response(
      JSON.stringify({
        totalImages,
        estimatedTokens,
      }),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    await logError('Error in image-analyze', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});


