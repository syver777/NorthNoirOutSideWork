import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseKey = (Deno.env.get('PUBLIC_KEY')) ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';

if (!supabaseUrl || !supabaseKey || !deepseekApiKey) {
  throw new Error('SUPABASE_URL, ANON_KEY, or DEEPSEEK_API_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseKey);

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

const TOKEN_PER_WORD = 1.33;

function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(word => word.length > 0).length * TOKEN_PER_WORD);
}

interface RequestBody {
  description: string;
  user_id: string;
  group_id: string;
}

function validateInputs(data: RequestBody): string | null {
  if (!data.description || typeof data.description !== 'string' || data.description.trim().length === 0) {
    return 'Missing or empty description';
  }
  if (!data.user_id || typeof data.user_id !== 'string') {
    return 'Missing or invalid user_id';
  }
  if (!data.group_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.group_id)) {
    return 'Missing or invalid group_id';
  }
  return null;
}

serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };
  const startTime = Date.now();
  const maxRuntime = 300000; // 5 minutes

  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: responseHeaders });
    }
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed', code: 405 }), {
        status: 405,
        headers: responseHeaders,
      });
    }

    const auth = await verifyAuth(req);
    if (!auth) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const payload: RequestBody = await req.json();
    if (!auth.isServiceRole && auth.userId) {
      payload.user_id = auth.userId;
    }
    const validationError = validateInputs(payload);
    if (validationError) {
      console.error(`Validation error: ${validationError}`);
      return new Response(JSON.stringify({ error: validationError, code: 400 }), {
        status: 400,
        headers: responseHeaders,
      });
    }

    const { description, user_id, group_id } = payload;

    const systemPrompt = `You are an expert at simplifying story descriptions for AI story generation. Given the user's description, rewrite it to:
- Be a short paragraph (50-100 words) summarizing the story's theme or main idea.
- Avoid mentioning story structure, chapters, or specific plot points, as the AI will handle those.
- Clearly state the desire for a story, not a script.
- Preserve the core theme and intent of the original description.
Return only the rewritten description as plain text, nothing else.`;

    const userPrompt = `Original description: ${description}`;

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${deepseekApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 300,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${errorText}`);
    }

    let fixedDescription = (await response.json()).choices[0].message.content.trim();

    const totalInputTokens = estimateTokens(systemPrompt + userPrompt);
    const totalOutputTokens = estimateTokens(fixedDescription);

    // Log token usage to story_tasks
    try {
      const { error: taskError } = await supabase
        .from('story_tasks')
        .insert({
          id: crypto.randomUUID(),
          user_id,
          group_id,
          batch_number: 0,
          status: 'completed',
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          task_type: 'fix_description',
        });

      if (taskError) {
        console.error('Failed to log fix-description task:', taskError);
      }
    } catch (err) {
      console.error('Error logging fix-description task:', err);
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > maxRuntime) {
      console.warn(`Function runtime exceeded safe limit: ${elapsed}ms`);
    }

    return new Response(
      JSON.stringify({ fixedDescription }),
      { status: 200, headers: responseHeaders }
    );
  } catch (error: any) {
    console.error(`Error in fix-description: ${error.message}`);
    await logError('Error in fix-description', error);
    let status = 500;
    let errorMessage = error.message || 'Internal server error';
    if (error.message.includes('rate limit') || error.message.includes('429')) {
      status = 429;
      errorMessage = 'Rate limit exceeded. Please try again later.';
    } else if (error.message.includes('invalid') || error.message.includes('missing')) {
      status = 400;
    } else if ([429, 500, 502, 503, 504, 520].some(code => error.message.includes(`HTTP ${code}`))) {
      status = parseInt(error.message.match(/HTTP (\d+)/)?.[1] || '500', 10);
      errorMessage = `DeepSeek API error: ${error.message}`;
    }
    return new Response(
      JSON.stringify({ error: errorMessage, code: status }),
      { status, headers: responseHeaders }
    );
  }
});

