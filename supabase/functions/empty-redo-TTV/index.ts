// empty-redo-TTV/index.ts
// Automatic content-moderation recovery for TTV tasks.
//
// Called by process-TTV and single-TTV whenever a video generation job returns
// status: 'failed' with error: 'content_moderation'.
//
// Flow:
//   1. Fetch the TTV_task by task_id
//   2. Extract the original prompt from batch[0].prompt
//   3. Rewrite the prompt with DeepSeek (video-specific safety prompt)
//   4a. [single_ttv tasks]  Submit fresh job to generate-TTV, update polling_id,
//       keep status='running', fire single-TTV in poll mode (fire-and-forget)
//   4b. [batch tasks]       Reset task to 'queued', fire process-TTV (fire-and-forget)
//   5. Return 200 immediately
//
// If DeepSeek fails the original prompt is used as fallback (with logging), so
// the task is never left permanently stuck.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyAuth } from '../_shared/utils.ts';
import { getCorsHeaders } from '../_shared/cors.ts';

// ── Env ────────────────────────────────────────────────────────────────────────
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const supabaseServiceRoleKey = Deno.env.get('SECRET_KEY') ?? '';
const deepseekApiKey = Deno.env.get('DEEPSEEK_API_KEY') ?? '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL or SECRET_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);



// ── Helpers ────────────────────────────────────────────────────────────────────
async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from('error_logs').insert({
      message,
      error_message: error.message || JSON.stringify(error),
      details: error.message || JSON.stringify(error),
      created_at: new Date().toISOString(),
    });
  } catch (_) { /* silent */ }
}

// ── Video prompt rewriter (DeepSeek) ──────────────────────────────────────────
// Preserves cinematic language (camera moves, lighting, motion, mood) while
// stripping or replacing whatever triggered content moderation.
function getVideoSafetySystemPrompt(language: string): string {
  const english = `You are an expert cinematic video prompt engineer. A text-to-video prompt was rejected by AI content moderation. Rewrite it to be fully safe while preserving every cinematic quality.

REMOVE OR REPLACE (moderation violations):
- Explicit violence, gore, graphic injury, or death descriptions
- Sexual content, nudity, or intimate / suggestive descriptions
- Hate speech, slurs, discrimination, or harmful stereotypes
- Content promoting illegal activities, self-harm, or terrorism
- Realistic compromising depictions of named real people

ALWAYS PRESERVE (cinematic language — do NOT alter these):
- Camera movements: "slow pan", "zoom in", "tracking shot", "aerial view", "dolly", "handheld", "crane shot", "tilt"
- Lighting & atmosphere: "golden hour", "soft light", "dramatic shadows", "cinematic lighting", "fog", "volumetric light", "backlit", "rim light"
- Composition: foreground/background elements, depth of field, perspective, rule of thirds, framing
- Motion: "flowing", "swirling", "running", "walking", "drifting", "cascading" — keep movement alive
- Color grading: "muted tones", "vibrant colors", "noir", "warm palette", "desaturated", "teal and orange"
- Emotional tone: "tense", "peaceful", "mysterious", "hopeful", "melancholic", "epic" — preserve the mood
- Setting and environment details: locations, weather, time of day, architecture
- Visual style: "cinematic", "photorealistic", "film grain", "anamorphic lens flare", "4K", "ultra-detailed"

TRANSFORMATION RULES:
- Violence → tension, urgency, dramatic action without injury (e.g. "brutal fight" → "intense standoff")
- Sexual content → tasteful, fully clothed, respectful interaction
- Graphic death → departure, fading, absence, an empty space
- Hate speech → neutral or positive portrayal of the group
- Keep the exact same story beat, scene setting, and emotional arc

Return ONLY the rewritten video prompt. Keep it concise and cinematic. No explanations.`;

  const byLanguage: Record<string, string> = {
    english,
    spanish: `Eres un experto en ingeniería de prompts de vídeo cinematográfico. Un prompt de texto a vídeo fue rechazado por moderación de contenido IA. Reescríbelo para que sea completamente seguro preservando toda su calidad cinematográfica.\n\nElimina: violencia explícita, contenido sexual, desnudez, discurso de odio, actividades ilegales, autolesiones.\nPreserva: movimientos de cámara, iluminación, atmósfera, composición, movimiento, estilo cinematográfico y tono emocional.\nTransforma manteniendo el mismo beat narrativo, escenario y arco emocional.\n\nDevuelve SOLO el prompt de vídeo reescrito en español. Sin explicaciones.`,
    german: `Du bist ein Experte für cinematisches Video-Prompt-Engineering. Ein Text-zu-Video-Prompt wurde von der KI-Inhaltsmoderation abgelehnt. Schreibe ihn um, damit er vollständig sicher ist, während du alle cinematischen Qualitäten bewahrst.\n\nEntferne: explizite Gewalt, sexuelle Inhalte, Nacktheit, Hassrede, illegale Aktivitäten, Selbstverletzung.\nBewahre: Kamerabewegungen, Beleuchtung, Atmosphäre, Komposition, Bewegung, cinematischen Stil und emotionalen Ton.\nTransformiere unter Beibehaltung desselben Story-Beats und emotionalen Bogens.\n\nGib NUR den umgeschriebenen Video-Prompt auf Deutsch zurück. Keine Erklärungen.`,
    french: `Vous êtes un expert en ingénierie de prompts vidéo cinématographiques. Un prompt texte-vers-vidéo a été rejeté par la modération de contenu IA. Réécrivez-le pour qu'il soit entièrement sûr tout en préservant toutes ses qualités cinématographiques.\n\nSupprimez: violence explicite, contenu sexuel, nudité, discours de haine, activités illégales, automutilation.\nPréservez: mouvements de caméra, éclairage, atmosphère, composition, mouvement, style cinématographique et ton émotionnel.\nTransformez en maintenant le même story beat et arc émotionnel.\n\nRetournez SEULEMENT le prompt vidéo réécrit en français. Sans explications.`,
  };

  return byLanguage[language] ?? byLanguage.english;
}

async function rewritePromptWithDeepSeek(
  prompt: string,
  language: string = 'english',
): Promise<string> {
  if (!deepseekApiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${deepseekApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: getVideoSafetySystemPrompt(language) },
        {
          role: 'user',
          content: `Original video prompt (rejected by content moderation):\n${prompt}`,
        },
      ],
      max_tokens: 2000,
      temperature: 0.7,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: HTTP ${response.status} — ${errorText.slice(0, 200)}`);
  }

  let content = '';
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          if (parsed.choices?.[0]?.delta?.content) {
            content += parsed.choices[0].delta.content;
          }
        } catch (_) { /* skip malformed SSE chunks */ }
      }
    }
  }

  const result = content.trim().replace(/^```(json)?/g, '').replace(/```$/g, '').trim();
  if (!result) throw new Error('DeepSeek returned an empty rewrite');
  return result;
}

// ── generate-TTV caller ─────────────────────────────────────────────────────
async function callGenerateTTV(body: Record<string, any>): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-TTV`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseServiceRoleKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`generate-TTV HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Main serve ─────────────────────────────────────────────────────────────────
serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: responseHeaders },
    );
  }

  const auth = await verifyAuth(req);
  if (!auth) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const body = await req.json();
    const { task_id } = body;

    if (!task_id || typeof task_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid task_id' }),
        { status: 400, headers: responseHeaders },
      );
    }

    // ── Fetch the task ─────────────────────────────────────────────────────────
    const { data: task, error: taskErr } = await supabase
      .from('TTV_tasks')
      .select('*')
      .eq('id', task_id)
      .single();

    if (taskErr || !task) {
      return new Response(
        JSON.stringify({ error: `Task not found: ${taskErr?.message ?? task_id}` }),
        { status: 404, headers: responseHeaders },
      );
    }

    // ── Extract prompt from batch ──────────────────────────────────────────────
    let batchArr: any[];
    try {
      batchArr = Array.isArray(task.batch) ? task.batch : JSON.parse(task.batch ?? '[]');
    } catch (_) {
      batchArr = [];
    }

    const originalPrompt: string = batchArr[0]?.prompt ?? task.text_part ?? '';

    if (!originalPrompt) {
      await logError(
        `[empty-redo-TTV] Task ${task_id} has no prompt`,
        new Error('empty prompt'),
      );
      return new Response(
        JSON.stringify({ error: 'Task has no prompt in batch data' }),
        { status: 400, headers: responseHeaders },
      );
    }

    console.log(
      `[empty-redo-TTV] Rewriting prompt for task ${task_id} (model=${task.video_model}, lang=${task.language ?? 'english'})`,
    );
    console.log(`[empty-redo-TTV] Original: ${originalPrompt.slice(0, 200)}`);

    // ── Rewrite prompt with DeepSeek ───────────────────────────────────────────
    // On failure, fall back to the original prompt so the task is never left stuck.
    let safePrompt = originalPrompt;
    let promptChanged = false;
    try {
      safePrompt = await rewritePromptWithDeepSeek(
        originalPrompt,
        task.language ?? 'english',
      );
      promptChanged = safePrompt !== originalPrompt;
      console.log(`[empty-redo-TTV] Rewritten: ${safePrompt.slice(0, 200)}`);
    } catch (rewriteErr: any) {
      console.warn(
        `[empty-redo-TTV] DeepSeek rewrite failed for task ${task_id}: ${rewriteErr.message} — resubmitting with original prompt`,
      );
      await logError('[empty-redo-TTV] DeepSeek rewrite failed', rewriteErr);
    }

    // ── Patch batch[0].prompt ────────────────────────────────────────────────
    const updatedBatch = batchArr.map((item: any, i: number) =>
      i === 0 ? { ...item, prompt: safePrompt } : item,
    );

    // ── Route: single_ttv vs batch ───────────────────────────────────────────
    if (task.single_ttv) {
      // ── Single-TTV path: submit a fresh job then resume polling ─────────────
      // single_ttv tasks live at status='running' and are owned entirely by
      // single-TTV — we must NOT reset to 'queued' or fire process-TTV.
      console.log(
        `[empty-redo-TTV] Task ${task_id} is single_ttv (model=${task.video_model}) — submitting fresh job to generate-TTV`,
      );

      let submitResult: any;
      try {
        submitResult = await callGenerateTTV({
          mode: 'submit',
          video_model: task.video_model,
          prompt: safePrompt,
          video_duration: task.video_duration,
          audio_clip: task.audio_clip ?? false,
        });
      } catch (submitErr: any) {
        await logError(
          `[empty-redo-TTV] generate-TTV submit failed for single_ttv task ${task_id}`,
          submitErr,
        );
        await supabase
          .from('TTV_tasks')
          .update({
            status: 'error',
            error: `empty-redo-TTV submit failed: ${submitErr.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', task_id);
        return new Response(
          JSON.stringify({ error: `generate-TTV submit failed: ${submitErr.message}` }),
          { status: 500, headers: responseHeaders },
        );
      }

      const newPollingId: string = submitResult.polling_id;
      const newPollingUrl: string | null = submitResult.polling_url ?? null;

      if (!newPollingId) {
        const noIdErr = new Error('No polling_id returned from generate-TTV');
        await logError(
          `[empty-redo-TTV] No polling_id from generate-TTV for single_ttv task ${task_id}`,
          noIdErr,
        );
        await supabase
          .from('TTV_tasks')
          .update({
            status: 'error',
            error: 'empty-redo-TTV: no polling_id from generate-TTV',
            updated_at: new Date().toISOString(),
          })
          .eq('id', task_id);
        return new Response(
          JSON.stringify({ error: 'No polling_id returned from generate-TTV' }),
          { status: 500, headers: responseHeaders },
        );
      }

      // Update task: store new polling info, keep status='running'
      const { error: singleUpdateErr } = await supabase
        .from('TTV_tasks')
        .update({
          batch: updatedBatch,
          status: 'running',
          polling_id: newPollingId,
          polling_url: newPollingUrl,
          poll_attempts: 0,
          check_stuck: false,
          error: promptChanged
            ? 'Content moderation — prompt rewritten, resubmitted'
            : 'Content moderation — resubmitted with original prompt',
          updated_at: new Date().toISOString(),
        })
        .eq('id', task_id);

      if (singleUpdateErr) {
        await logError(
          `[empty-redo-TTV] Failed to update single_ttv task ${task_id}`,
          singleUpdateErr,
        );
        return new Response(
          JSON.stringify({ error: `Failed to update task: ${singleUpdateErr.message}` }),
          { status: 500, headers: responseHeaders },
        );
      }

      console.log(
        `[empty-redo-TTV] single_ttv task ${task_id} resubmitted` +
        ` (polling_id=${newPollingId}, prompt_changed=${promptChanged}) — firing single-TTV poll mode`,
      );

      // Fire single-TTV in poll mode (fire-and-forget)
      // The poll mode handler sleeps 30 s then polls; if the job is still
      // pending it self-schedules until done or max attempts.
      fetch(`${supabaseUrl}/functions/v1/single-TTV`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceRoleKey,
        },
        body: JSON.stringify({
          single_ttv_poll_mode: true,
          task_id,
          polling_id: newPollingId,
          polling_url: newPollingUrl,
          video_model: task.video_model,
          video_duration: task.video_duration,
          poll_attempt: 0,
        }),
      }).catch((e: any) => {
        console.error(
          `[empty-redo-TTV] Failed to fire single-TTV poll mode for task ${task_id}:`,
          e.message,
        );
        logError('[empty-redo-TTV] Failed to fire single-TTV poll mode after rewrite', e);
      });

      return new Response(
        JSON.stringify({
          status: 'resubmitted',
          task_id,
          prompt_changed: promptChanged,
          message: 'Prompt rewritten, fresh job submitted — single-TTV poll mode fired',
        }),
        { status: 200, headers: responseHeaders },
      );
    }

    // ── Batch TTV path: reset to queued and fire process-TTV ─────────────────
    const { error: updateErr } = await supabase
      .from('TTV_tasks')
      .update({
        batch: updatedBatch,
        status: 'queued',
        polling_id: null,
        polling_url: null,
        poll_attempts: 0,
        check_stuck: false,
        error: promptChanged
          ? 'Content moderation rejection — prompt rewritten by empty-redo-TTV'
          : 'Content moderation rejection — resubmitting with original prompt',
        updated_at: new Date().toISOString(),
      })
      .eq('id', task_id);

    if (updateErr) {
      await logError(`[empty-redo-TTV] Failed to update task ${task_id}`, updateErr);
      return new Response(
        JSON.stringify({ error: `Failed to update task: ${updateErr.message}` }),
        { status: 500, headers: responseHeaders },
      );
    }

    console.log(
      `[empty-redo-TTV] Task ${task_id} reset to queued (prompt_changed=${promptChanged}) — firing process-TTV`,
    );

    // ── Fire process-TTV (fire-and-forget) ────────────────────────────────────
    // process-TTV owns the full submit → poll → compile pipeline, so we hand
    // control back to it rather than duplicating that logic here.
    fetch(`${supabaseUrl}/functions/v1/process-TTV`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceRoleKey,
      },
      body: JSON.stringify({
        group_id: task.group_id,
        user_id: task.user_id,
        batch_number: task.batch_number,
        total_batches: task.total_batches,
        tab: task.tab ?? 1,
        variant: task.variant ?? 1,
      }),
    }).catch((e: any) => {
      console.error(
        `[empty-redo-TTV] Failed to fire process-TTV for task ${task_id}:`,
        e.message,
      );
      logError('[empty-redo-TTV] Failed to fire process-TTV after rewrite', e);
    });

    return new Response(
      JSON.stringify({
        status: 'resubmitted',
        task_id,
        prompt_changed: promptChanged,
        message: 'Prompt rewritten and task requeued — process-TTV fired',
      }),
      { status: 200, headers: responseHeaders },
    );
  } catch (error: any) {
    await logError('[empty-redo-TTV] Unhandled error', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: responseHeaders },
    );
  }
});
