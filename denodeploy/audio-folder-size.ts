import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://yilrqukialrbdzydvwmt.supabase.co';
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SECRET_KEY') || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SUPABASE_SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

const ALLOWED_ORIGINS = [
  'https://storyscriptai.com',
  'https://www.storyscriptai.com',
  'https://northnoir.com',
  'https://www.northnoir.com',
  'http://localhost:5173',
];

function getCorsOrigin(req: Request): string {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
function getCorsHeaders(req: Request): Record<string, string> {
  const corsOrigin = getCorsOrigin(req);
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    const { error: dbError } = await supabase
      .from('error_logs')
      .insert({
        error_message: message, // Fixed: use correct column name
        error_details: error.message || JSON.stringify(error),
        created_at: new Date().toISOString(),
      });
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });

    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    // Verify authentication
    const authHeader = req.headers.get('Authorization');
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : (req.headers.get('apikey') || '');
    if (!authToken) {
      return new Response(JSON.stringify({ error: 'Missing authorization', code: 401 }), { status: 401, headers: responseHeaders });
    }    // authToken resolved above (Bearer or apikey)

    const _secretKey = Deno.env.get('SUPABASE_SECRET_KEY') || '';
    const _allowedServerKeys = [_secretKey].filter(Boolean);
    if (!_allowedServerKeys.includes(authToken)) {
      const { data: { user: _authUser }, error: _authErr } = await supabase.auth.getUser(authToken);
      if (_authErr || !_authUser) {
        return new Response(JSON.stringify({ error: 'Invalid or expired token', code: 401 }), { status: 401, headers: responseHeaders });
      }
    }

    let payload;
    try {
      payload = await req.json();
    } catch (error) {
      await logError('Invalid JSON payload', error);
      return new Response(JSON.stringify({ error: 'Invalid JSON payload', code: 400 }), { status: 400, headers: responseHeaders });
    }

    const { id, file_path, version } = payload;

    if (!id || !file_path || !version) {
      await logError('Missing required fields', new Error('id, file_path, or version missing'));
      return new Response(JSON.stringify({ error: 'Missing required fields', code: 400 }), { status: 400, headers: responseHeaders });
    }

    const validVersions = [9, 10, 14, 15, 22, 23, 26, 27];
    if (!validVersions.includes(version)) {
      await logError('Invalid version for this function', new Error(`Version ${version} not supported`));
      return new Response(JSON.stringify({ error: 'Invalid version for this function', code: 400 }), { status: 400, headers: responseHeaders });
    }

    // v14/v15 = TTV video folders (.mp4); v22/v23 = ITV video folders (.mp4); v26/v27 = MG video folders (.mp4); v9/v10 = audio folders (.mp3/.wav)
    const isMp4Folder = version === 14 || version === 15 || version === 22 || version === 23 || version === 26 || version === 27;

    let totalSize = 0;

    // Use list() with search options to get file metadata including size
    const { data: files, error: listError } = await supabase.storage
      .from('stories')
      .list(file_path, {
        limit: 1000,
        sortBy: { column: 'name', order: 'asc' }
      });

    if (listError) {
      await logError(`Failed to list files for ${file_path}`, listError);
      return new Response(JSON.stringify({ error: 'Failed to list files', code: 500 }), { status: 500, headers: responseHeaders });
    }

    // Calculate total size from metadata without downloading files
    for (const file of files) {
      if (isMp4Folder) {
        if (!file.name.endsWith('.mp4')) continue;
      } else {
        if (!file.name.endsWith('.mp3') && !file.name.endsWith('.wav')) continue;
      }
      
      // Use file.metadata.size if available, otherwise try to get it via HEAD request
      if (file.metadata?.size) {
        totalSize += file.metadata.size;
      } else {
        // Fallback: use HEAD request to get Content-Length without downloading
        try {
          const { data: urlData } = await supabase.storage
            .from('stories')
            .createSignedUrl(`${file_path}/${file.name}`, 60);
          
          if (urlData?.signedUrl) {
            const headResponse = await fetch(urlData.signedUrl, { method: 'HEAD' });
            const contentLength = headResponse.headers.get('content-length');
            if (contentLength) {
              totalSize += parseInt(contentLength, 10);
            }
          }
        } catch (headError) {
          console.error(`Failed to get size for ${file.name}:`, headError);
          // Continue without this file rather than failing completely
        }
      }
    }

    const { error: updateError } = await supabase
      .from('story_documents')
      .update({ file_size: totalSize })
      .eq('id', id);

    if (updateError) {
      await logError(`Failed to update file_size for ${id}`, updateError);
      return new Response(JSON.stringify({ error: 'Failed to update file_size', code: 500 }), { status: 500, headers: responseHeaders });
    }

    return new Response(JSON.stringify({ success: true, file_size: totalSize }), { status: 200, headers: responseHeaders });
  } catch (err) {
    await logError('Error in Deno Deploy Function', err);
    return new Response(JSON.stringify({ error: 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
});




