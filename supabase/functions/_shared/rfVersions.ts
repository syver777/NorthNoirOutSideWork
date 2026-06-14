/** RF story_documents versions — prompts 28/29, clip folders 30/31 */
export const RF_PROMPT_VERSION_ORIGINAL = 28;
export const RF_PROMPT_VERSION_CORRECTED = 29;
export const RF_CLIP_VERSION_ORIGINAL = 30;
export const RF_CLIP_VERSION_CORRECTED = 31;

export function rfPromptVersion(isCorrected: boolean): number {
  return isCorrected ? RF_PROMPT_VERSION_CORRECTED : RF_PROMPT_VERSION_ORIGINAL;
}

export function rfClipVersion(isCorrected: boolean): number {
  return isCorrected ? RF_CLIP_VERSION_CORRECTED : RF_CLIP_VERSION_ORIGINAL;
}
