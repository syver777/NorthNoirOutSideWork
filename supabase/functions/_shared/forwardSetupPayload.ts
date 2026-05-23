// Builds the common setup-video-tasks payload from an existing main
// `video_tasks` row. Used by the four end-of-pipeline bridges
// (process-image, process-audio, process-TTV, process-ITV) to forward every
// user-configured setting (subtitles, volume, pauses, master_prompt,
// frequency_*, customCharacters*, etc.) so the row created by
// setup-video-tasks preserves them instead of resetting to defaults.
//
// Note: we intentionally do NOT pass `video_task_id`. The two-row architecture
// is preserved \u2014 setup-video-tasks creates its own placeholder and main row.
//
// Bridge-specific fields (use_existing_*, file paths, visual_type,
// process_ttv/process_itv) are added by each caller after spreading.

export interface ForwardablePayload {
  user_id: string;
  group_id: string;
  tab: number | null;
  story_title: string;
  description: string;
  word_count: number;
  language: string;
  // Image / story models
  image_style: unknown;
  use_character_descriptions: boolean | null;
  first_page_frequency: number | null;
  rest_frequency: number | null;
  image_model: string | null;
  story_model?: string | null;
  model?: string | null; // image prompt model
  // Voice / audio
  voice: string | null;
  model_version: string | null;
  speed: number | null;
  preference: string | null;
  remove_title_chapters: boolean | null;
  clone_voice_name: string | null;
  clone_voice_url: string | null;
  clone_language: string | null;
  // The three *_volume fields below are validated by setup-video-tasks with
  // `!== undefined` checks (see index.ts lines 277, 289, 303). Sending `null`
  // fails the typeof check, so we must OMIT them when not set. Hence `?` and
  // `?? undefined` below.
  volume?: number;
  existing_audio_volume?: number;
  bg_music_volume?: number;
  pauses: boolean;
  // Output / video
  output_video_name: string | null;
  bg_music: string | null;
  video_loop: string | null;
  loop_time: number | null;
  transition_type: string | null;
  animation_type: string | null;
  effects_type: string | null;
  variant: number | null;
  subtitles: unknown;
  // Frequency / distribution
  frequency_mode?: string | null;
  frequency_type?: string | null;
  consistent_frequency?: unknown;
  audio_distribution_type?: string | null;
  first_page_image_amount?: number | null;
  rest_image_amount?: number | null;
  total_audio_duration?: number | null;
  image_amount?: number | null;
  audio_files?: unknown;
  // Master prompt
  master_prompt?: unknown;
  master_prompt_enhance_ai?: boolean | null;
  // Custom characters
  customCharactersEnabled?: boolean;
  customCharacters?: unknown;
  customCharactersAIEnhance?: boolean;
  // YouTube
  youtube_links?: unknown;
  youtube_transcript_text?: unknown;
  // Runtime mode
  is_runtime_mode?: boolean | null;
  runtime_minutes?: number | null;
  // Processing flags
  video?: boolean;
  process_story?: boolean;
  process_images?: boolean;
  process_audio?: boolean;
  // TTV/ITV models (forwarded for completeness; bridges may override)
  visual_type?: string | null;
  video_model?: string | null;
  video_duration?: number | null;
  itv_model?: string | null;
  itv_duration?: number | null;
}

/**
 * Coerce the columns we read off the existing main `video_tasks` row into the
 * shape `setup-video-tasks` expects. Caller spreads the result and then adds
 * pipeline-specific overrides (use_existing_*, file paths, visual_type, etc).
 *
 * `vt` is the full row \u2014 caller must select with `*`.
 */
export function buildForwardPayload(args: {
  vt: any;
  userId: string;
  groupId: string;
  tab: number | null;
}): ForwardablePayload {
  const { vt, userId, groupId, tab } = args;
  // Settings JSON has some legacy fields (customCharacters*, master_prompt_enhance_ai)
  // that aren't promoted to columns. Pull from there as a fallback.
  const s = (vt.settings && typeof vt.settings === 'object') ? vt.settings : {};

  // audio_files is JSON-stringified on disk; setup-video-tasks expects an array.
  let audioFiles: unknown = vt.audio_files ?? s.audio_files ?? null;
  if (typeof audioFiles === 'string') {
    try { audioFiles = JSON.parse(audioFiles); } catch { audioFiles = null; }
  }

  return {
    user_id: userId,
    group_id: groupId,
    tab: tab ?? vt.tab ?? null,
    story_title: vt.story_title,
    description: vt.description,
    word_count: 0, // Bridges always run after content already exists.
    language: vt.text_language || s.text_language || 'english',
    image_style: vt.image_style ?? null,
    use_character_descriptions: vt.use_character_descriptions ?? null,
    first_page_frequency: vt.first_page_frequency ?? null,
    rest_frequency: vt.rest_frequency ?? null,
    image_model: vt.image_model ?? null,
    story_model: vt.story_model ?? s.story_model ?? null,
    model: vt.model ?? s.model ?? null,
    voice: vt.voice ?? null,
    model_version: vt.model_version ?? null,
    speed: vt.speed ?? null,
    preference: vt.preference ?? null,
    remove_title_chapters: vt.remove_title_chapters ?? null,
    clone_voice_name: vt.clone_voice_name ?? null,
    clone_voice_url: vt.clone_voice_url ?? null,
    clone_language: vt.clone_language ?? null,
    // Use `?? undefined` (not `?? null`) so JSON.stringify drops the key when
    // unset — setup-video-tasks rejects explicit `null` for these fields.
    volume: (vt.volume ?? s.volume) ?? undefined,
    existing_audio_volume: (vt.existing_audio_volume ?? s.existing_audio_volume) ?? undefined,
    bg_music_volume: (vt.bg_music_volume ?? s.bg_music_volume) ?? undefined,
    pauses: !!(vt.pauses ?? s.pauses ?? false),
    output_video_name: vt.output_video_name ?? null,
    bg_music: vt.bg_music ?? null,
    video_loop: vt.video_loop ?? null,
    loop_time: vt.loop_time ?? null,
    transition_type: vt.transition_type ?? null,
    animation_type: vt.animation_type ?? null,
    effects_type: vt.effects_type ?? null,
    variant: vt.variant ?? null,
    // Subtitles config \u2014 the original cause of the burn-in regression. Forward
    // the full object (or null) verbatim so setup-video-tasks re-applies it.
    subtitles: vt.subtitles ?? s.subtitles ?? null,
    frequency_mode: vt.frequency_mode ?? s.frequency_mode ?? null,
    frequency_type: vt.frequency_type ?? s.frequency_type ?? null,
    consistent_frequency: vt.consistent_frequency ?? s.consistent_frequency ?? null,
    audio_distribution_type: vt.audio_distribution_type ?? s.audio_distribution_type ?? null,
    first_page_image_amount: vt.first_page_image_amount ?? s.first_page_image_amount ?? null,
    rest_image_amount: vt.rest_image_amount ?? s.rest_image_amount ?? null,
    total_audio_duration: vt.total_audio_duration ?? null,
    image_amount: vt.image_amount ?? vt.total_individual_videos ?? null,
    audio_files: audioFiles,
    master_prompt: vt.master_prompt ?? s.master_prompt ?? null,
    master_prompt_enhance_ai: s.master_prompt_enhance_ai ?? false,
    customCharactersEnabled: !!(s.customCharactersEnabled ?? false),
    customCharacters: s.customCharacters ?? [],
    customCharactersAIEnhance: !!(s.customCharactersAIEnhance ?? false),
    youtube_links: vt.youtube_links ?? s.youtube_links ?? null,
    youtube_transcript_text: vt.youtube_transcript_text ?? s.youtube_transcript_text ?? null,
    is_runtime_mode: vt.is_runtime_mode ?? s.is_runtime_mode ?? null,
    runtime_minutes: vt.runtime_minutes ?? s.runtime_minutes ?? null,
    video: vt.video ?? s.video ?? true,
    process_story: vt.process_story ?? s.process_story ?? true,
    process_images: vt.process_images ?? s.process_images ?? true,
    process_audio: vt.process_audio ?? s.process_audio ?? true,
    visual_type: vt.visual_type ?? null,
    video_model: vt.video_model ?? null,
    video_duration: vt.video_duration ?? null,
    itv_model: vt.itv_model ?? null,
    itv_duration: vt.itv_duration ?? null,
  };
}
