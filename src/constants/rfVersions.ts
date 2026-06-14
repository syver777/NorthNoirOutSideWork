/** RF story_documents versions — prompts 28/29, clip folders 30/31 */
export const RF_PROMPT_VERSION_ORIGINAL = 28;
export const RF_PROMPT_VERSION_CORRECTED = 29;
export const RF_CLIP_VERSION_ORIGINAL = 30;
export const RF_CLIP_VERSION_CORRECTED = 31;

export const RF_PROMPT_VERSIONS = [RF_PROMPT_VERSION_ORIGINAL, RF_PROMPT_VERSION_CORRECTED] as const;
export const RF_CLIP_VERSIONS = [RF_CLIP_VERSION_ORIGINAL, RF_CLIP_VERSION_CORRECTED] as const;
export const RF_ALL_VERSIONS = [...RF_PROMPT_VERSIONS, ...RF_CLIP_VERSIONS] as const;

export function isRFPromptVersion(version: number): boolean {
  return (RF_PROMPT_VERSIONS as readonly number[]).includes(version);
}

export function isRFClipVersion(version: number): boolean {
  return (RF_CLIP_VERSIONS as readonly number[]).includes(version);
}
