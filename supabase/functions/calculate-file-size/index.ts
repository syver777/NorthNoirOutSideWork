import { serve } from 'https://deno.land/std@0.223.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';
import { fetchWithDenoFallback } from '../_shared/fetchWithDenoFallback.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://yilrqukialrbdzydvwmt.supabase.co';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') || '';

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
    if (dbError) {
      console.error('Failed to log error to database:', dbError);
    }
  } catch (err) {
    console.error('Error logging to database:', err);
  }
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders });
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), { status: 405, headers: responseHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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

    let totalSize = 0;
    // Single-file versions: story docs, TTV prompt JSONs, ITV prompt JSONs, MG prompt JSONs
    if ((version >= 1 && version <= 4) || version === 7 || version === 8 ||
        version === 12 || version === 13 ||
        version === 16 || version === 17 ||   // ITV image-prompt JSON
        version === 20 || version === 21 ||   // ITV video-prompt JSON
        version === 24 || version === 25) {   // MG prompt JSON
      const { data, error } = await supabase.storage
        .from('stories')
        .download(file_path);
      if (error) {
        await logError(`Failed to fetch file ${file_path}`, error);
        totalSize = 0;
      } else {
        const buffer = await data.arrayBuffer();
        totalSize = buffer.byteLength;
      }
    } else if (version === 5 || version === 6 ||
               version === 18 || version === 19) {  // v18/19 = ITV keyframe image folder (PNGs)
      const { data: files, error: listError } = await supabase.storage
        .from('stories')
        .list(file_path, {
          limit: 1000,
          sortBy: { column: 'name', order: 'asc' }
        });
        
      if (listError) {
        await logError(`Failed to list files for ${file_path}`, listError);
        totalSize = 0;
      } else {
        for (const file of files) {
          if (!file.name.endsWith('.png')) continue;
          
          if (file.metadata?.size) {
            totalSize += file.metadata.size;
          } else {
            // Fallback to HEAD request
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
            }
          }
        }
      }
    } else if (version === 9 || version === 10) {
      const response = await fetchWithDenoFallback('audio-folder-size', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({ id, file_path, version }),
      });
    
      if (!response.ok) {
        const errorText = await response.text();
        await logError(`Deno Deploy function failed for ${file_path}`, new Error(errorText));
        return new Response(JSON.stringify({ error: 'Failed to calculate audio folder size', code: 500 }), { status: 500, headers: responseHeaders });
      }
    
      const { file_size } = await response.json();
      totalSize = file_size;
    } else if (version === 14 || version === 15 ||
               version === 22 || version === 23 ||   // v22/23 = ITV video folder (.mp4)
               version === 26 || version === 27) {   // v26/27 = MG video folder (.mp4)
      // TTV, ITV, and MG video folders: delegate to the audio-folder-size edge function
      const response = await fetchWithDenoFallback('audio-folder-size', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({ id, file_path, version }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        await logError(`Deno Deploy function failed for video folder ${file_path}`, new Error(errorText));
        return new Response(JSON.stringify({ error: 'Failed to calculate video folder size', code: 500 }), { status: 500, headers: responseHeaders });
      }

      const { file_size } = await response.json();
      totalSize = file_size;
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
    await logError('Error in Edge Function', err);
    return new Response(JSON.stringify({ error: 'Internal server error', code: 500 }), { status: 500, headers: responseHeaders });
  }
}, { verifyJWT: false });



