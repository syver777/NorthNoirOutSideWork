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



interface StopVideoRequest {
  video_task_id: string;
  user_id: string;
  group_id: string;
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

    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }), 
        { status: 405, headers: responseHeaders }
      );
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const requestData: StopVideoRequest = await req.json();
    
    const { video_task_id, user_id, group_id } = requestData;

    if (!video_task_id || !user_id || !group_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }), 
        { status: 400, headers: responseHeaders }
      );
    }

    // Verify the user owns this video task
    const { data: videoTask, error: taskError } = await supabase
      .from('video_tasks')
      .select('id, user_id, group_id')
      .eq('id', video_task_id)
      .eq('user_id', user_id)
      .eq('group_id', group_id)
      .single();

    if (taskError || !videoTask) {
      console.error('Video task not found or access denied:', taskError);
      return new Response(
        JSON.stringify({ error: 'Video task not found or access denied' }), 
        { status: 404, headers: responseHeaders }
      );
    }

    console.log(`Stopping video processing for task ${video_task_id}`);

    // Call the GCloud function with SERVICE_ROLE_KEY authentication
    const response = await fetch('https://us-central1-story-script-ai.cloudfunctions.net/image-to-video-processor', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        action: 'stop',
        video_task_id,
        user_id,
        group_id
      }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`Successfully stopped video processing for task ${video_task_id}`);
      return new Response(JSON.stringify({
        status: 'success',
        message: 'Video processing stop request sent',
        result
      }), { status: 200, headers: responseHeaders });
    } else {
      const errorText = await response.text();
      console.error(`Failed to stop video processing: ${response.status} - ${errorText}`);
      return new Response(
        JSON.stringify({ 
          error: 'Failed to stop video processing',
          details: errorText
        }), 
        { status: response.status, headers: responseHeaders }
      );
    }

  } catch (error: any) {
    await logError('Error in stop-video-processing', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }), 
      { status: 500, headers: responseHeaders }
    );
  }
});
