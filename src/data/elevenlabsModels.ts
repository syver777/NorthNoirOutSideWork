// ElevenLabs models exposed to the user.
// Token-per-character multipliers come from SSAITTS2.py and yield $2 per
// 1,000,000 user-tokens at a ~40% margin off the Creator-plan overage rate.
//
//   multilingual_v2 → 1 credit/char  → 200 tokens/char
//   turbo_v2_5      → 0.5 credit/char → 100 tokens/char
//   flash_v2_5      → 0.5 credit/char → 100 tokens/char
//
// Adjust if the upstream cost changes.

export interface ElevenLabsModel {
  id: string;
  label: string;
  description: string;
  /** Tokens we charge per character generated with this model. */
  tokensPerChar: number;
  /** Approximate latency hint shown in the UI. */
  latency: 'standard' | 'low' | 'lowest';
  /** Quality hint shown in the UI. */
  quality: 'highest' | 'high' | 'fast';
}

export const ELEVENLABS_MODELS: ElevenLabsModel[] = [
  {
    id: 'eleven_multilingual_v2',
    label: 'Multilingual v2',
    description: 'Highest quality, lifelike multilingual model.',
    tokensPerChar: 200,
    latency: 'standard',
    quality: 'highest',
  },
  {
    id: 'eleven_turbo_v2_5',
    label: 'Turbo v2.5',
    description: 'Low-latency, half the cost. Great for long-form.',
    tokensPerChar: 100,
    latency: 'low',
    quality: 'high',
  },
  {
    id: 'eleven_flash_v2_5',
    label: 'Flash v2.5',
    description: 'Fastest model with the lowest latency.',
    tokensPerChar: 100,
    latency: 'lowest',
    quality: 'fast',
  },
];

export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';

/** Returns the model object for an id, or the default model if unknown. */
export function getElevenLabsModel(id: string | undefined | null): ElevenLabsModel {
  return (
    ELEVENLABS_MODELS.find((m) => m.id === id) ??
    ELEVENLABS_MODELS.find((m) => m.id === DEFAULT_ELEVENLABS_MODEL_ID)!
  );
}

/**
 * Some voices on ElevenLabs are restricted to specific base models.
 * The shared / library voice payload exposes `high_quality_base_model_ids`.
 * If that array is present and non-empty, the voice can ONLY be used with
 * those models. Otherwise all models are valid.
 */
export function isModelCompatibleWithVoice(
  modelId: string,
  highQualityBaseModelIds?: string[] | null,
): boolean {
  if (!highQualityBaseModelIds || highQualityBaseModelIds.length === 0) return true;
  return highQualityBaseModelIds.includes(modelId);
}

/**
 * Picks the best default model for a given voice:
 *   - If the user's currently-selected model is compatible, keep it.
 *   - Otherwise prefer multilingual_v2 if compatible, then turbo, then flash.
 *   - Otherwise return the first id the voice supports.
 */
export function pickModelForVoice(
  currentModelId: string,
  highQualityBaseModelIds?: string[] | null,
): string {
  if (isModelCompatibleWithVoice(currentModelId, highQualityBaseModelIds)) {
    return currentModelId;
  }
  for (const m of ELEVENLABS_MODELS) {
    if (isModelCompatibleWithVoice(m.id, highQualityBaseModelIds)) return m.id;
  }
  return highQualityBaseModelIds?.[0] ?? DEFAULT_ELEVENLABS_MODEL_ID;
}
