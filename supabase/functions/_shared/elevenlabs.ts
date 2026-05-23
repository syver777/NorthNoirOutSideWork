// Shared ElevenLabs constants for edge functions.
// Token-per-character multipliers must stay in sync with src/data/elevenlabsModels.ts.

export const ELEVENLABS_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export const ELEVENLABS_TOKENS_PER_CHAR: Record<string, number> = {
  eleven_multilingual_v2: 200,
  eleven_turbo_v2_5: 100,
  eleven_flash_v2_5: 100,
};

export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';

export function elevenLabsTokensPerChar(modelId: string | undefined | null): number {
  if (!modelId) return ELEVENLABS_TOKENS_PER_CHAR[DEFAULT_ELEVENLABS_MODEL_ID];
  return ELEVENLABS_TOKENS_PER_CHAR[modelId] ?? ELEVENLABS_TOKENS_PER_CHAR[DEFAULT_ELEVENLABS_MODEL_ID];
}

export interface ElevenLabsTtsParams {
  apiKey: string;
  voiceId: string;
  modelId: string;
  text: string;
  /** Speech speed; clamped to 0.7-1.2 per ElevenLabs API. */
  speed: number;
  /** Optional output format; defaults to mp3_44100_128. */
  outputFormat?: string;
}

/**
 * Calls ElevenLabs TTS and returns base64-encoded MP3 plus the token cost
 * computed from char count * tokens_per_char for the model.
 */
export async function callElevenLabsTts(
  params: ElevenLabsTtsParams,
): Promise<{ audio_base64: string; tokens: number }> {
  const { apiKey, voiceId, modelId, text, speed, outputFormat = 'mp3_44100_128' } = params;

  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  if (!voiceId) throw new Error('Missing ElevenLabs voice_id');

  const clampedSpeed = Math.max(0.7, Math.min(1.2, speed));
  const url = `${ELEVENLABS_TTS_URL}/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  const body = {
    text,
    model_id: modelId,
    voice_settings: {
      speed: clampedSpeed,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs HTTP ${res.status}: ${errText}`);
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunk to avoid call-stack issues on large buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  const audio_base64 = btoa(binary);

  const tokens = text.length * elevenLabsTokensPerChar(modelId);
  return { audio_base64, tokens };
}
