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

interface ProcessTransitionBatchesRequest {
  video_task_id: string;
  user_id: string;
  group_id: string;
  continue_from_batch?: number;
  transition_type?: string;
  transition_duration?: number;
  final_assembly?: boolean;
  tab?: number; // Default 1 - tab number for enterprise users
  // Async subtitle burn dispatch: when true, the create-final-video call is
  // a re-entry that downloads the already-uploaded final video, burns the
  // configured subtitles in, and re-uploads. Skips normal batch processing.
  burn_subtitles_only?: boolean;
  burn_subtitles_retry?: boolean;
  // Chunked subtitle burn fan-out (only meaningful when burn_subtitles_only=true).
  // The dispatcher GCF (first burn_subtitles_only call) plans the chunks, writes
  // subtitle_burn_state, then re-enters this edge function once per chunk with
  // subtitle_chunk_index set. After the last chunk uploads, the GCF re-enters
  // with subtitle_concat_chunks=true to assemble + finalize tokens.
  subtitle_chunk_index?: number;
  subtitle_concat_chunks?: boolean;
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

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }), 
        { status: 405, headers: responseHeaders }
      );
    }

    const requestData: ProcessTransitionBatchesRequest = await req.json();
    
    const { 
      video_task_id, 
      user_id, 
      group_id, 
      continue_from_batch = 1, 
      transition_type, 
      transition_duration,
      final_assembly = false,
      tab = 1,
      burn_subtitles_only = false,
      burn_subtitles_retry = false,
      subtitle_chunk_index,
      subtitle_concat_chunks = false,
    } = requestData;

    if (!video_task_id || !user_id || !group_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }), 
        { status: 400, headers: responseHeaders }
      );
    }

    if (burn_subtitles_only) {
      console.log(`Dispatching async subtitle burn for video task ${video_task_id} (retry=${burn_subtitles_retry})`);
    } else if (final_assembly) {
      console.log(`Processing final assembly for video task ${video_task_id}`);
    } else {
      console.log(`Processing transition batches for video task ${video_task_id}, starting from batch ${continue_from_batch}`);
    }

    // Fetch gc_version for versioned GCF routing
    const { data: taskVersionData } = await supabase
      .from('video_tasks')
      .select('gc_version')
      .eq('id', video_task_id)
      .single();
    const gcVersion: number = taskVersionData?.gc_version ?? 1;
    const gcfSuffix = gcVersion > 1 ? String(gcVersion) : '';
    const createFinalVideoUrl = `https://us-central1-story-script-ai.cloudfunctions.net/create-final-video${gcfSuffix}`;
    console.log(`Using GCF URL: ${createFinalVideoUrl} (gc_version=${gcVersion})`);

    // Fire-and-forget call to create-final-video
    fetch(createFinalVideoUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify(
        burn_subtitles_only
          ? {
              video_task_id,
              user_id,
              group_id,
              burn_subtitles_only: true,
              burn_subtitles_retry,
              tab,
              ...(typeof subtitle_chunk_index === 'number' && { subtitle_chunk_index }),
              ...(subtitle_concat_chunks && { subtitle_concat_chunks: true }),
            }
          : {
              video_task_id,
              user_id,
              group_id,
              final_assembly,
              continue_batch_processing: !final_assembly,
              continue_from_batch,
              transition_type,
              transition_duration,
              tab,
            }
      ),
    }).then(response => {
      if (response.ok) {
        if (burn_subtitles_only) {
          console.log(`Successfully triggered subtitle burn (retry=${burn_subtitles_retry})`);
        } else if (final_assembly) {
          console.log(`Successfully triggered final assembly`);
        } else {
          console.log(`Successfully triggered batch ${continue_from_batch} processing`);
        }
      } else {
        if (burn_subtitles_only) {
          console.error(`Failed to trigger subtitle burn: ${response.status}`);
        } else if (final_assembly) {
          console.error(`Failed to trigger final assembly: ${response.status}`);
        } else {
          console.error(`Failed to trigger batch ${continue_from_batch} processing: ${response.status}`);
        }
      }
    }).catch(error => {
      if (burn_subtitles_only) {
        console.error(`Error triggering subtitle burn:`, error);
      } else if (final_assembly) {
        console.error(`Error triggering final assembly:`, error);
      } else {
        console.error(`Error triggering batch ${continue_from_batch} processing:`, error);
      }
    });

    return new Response(JSON.stringify({
      status: 'triggered',
      message: burn_subtitles_only
        ? `Subtitle burn started (retry=${burn_subtitles_retry})`
        : final_assembly
          ? 'Final assembly started'
          : `Batch ${continue_from_batch} processing started`,
      video_task_id,
      burn_subtitles_only,
      final_assembly,
      continue_from_batch: final_assembly || burn_subtitles_only ? undefined : continue_from_batch,
      transition_type,
      transition_duration,
    }), { status: 200, headers: responseHeaders });

  } catch (error: any) {
    await logError('Error in process-transition-batches', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }), 
      { status: 500, headers: responseHeaders }
    );
  }
});



