# NorthNoir - Technical Documentation

> Formerly known as StoryScriptAI. Some internal function/file names (e.g. `storyscriptai-outline.ts`, `storyscriptai-parse.ts`, `storyscriptai-setup-prompt.ts`) keep the legacy prefix for backwards compatibility — they are part of the same NorthNoir platform.

## Table of Contents

1. [System Overview](#system-overview)
2. [V2 Updates & New Features](#v2-updates--new-features)
3. [Story Generator](#story-generator)
4. [Story Comparison](#story-comparison)
5. [Text-to-Speech Generation](#text-to-speech-generation)
6. [Image Prompt Generation](#image-prompt-generation)
7. [Image Generation](#image-generation)
8. [Video Generator](#video-generator)
9. [Development Setup](#development-setup)
10. [Troubleshooting](#troubleshooting)
11. [API Reference](#api-reference)
12. [Text-to-Video (TTV) Generator](#text-to-video-ttv-generator)
13. [Image-to-Video (ITV) Generator](#image-to-video-itv-generator)
14. [Motion Graphics (MG) Generator](#motion-graphics-mg-generator)
15. [Combine Video](#combine-video)
16. [Pricing & Subscription](#pricing--subscription)
17. [Deployment & Environment Variables](#deployment--environment-variables)

---

## System Overview

NorthNoir is a comprehensive content generation platform that combines AI-powered story writing, text-to-speech conversion, image generation, text-to-video generation, image-to-video generation, AI-driven motion graphics, and full video production. Everything from a single short prompt all the way to a finished narrated YouTube-ready video can be produced in one pipeline. The system uses a microservices architecture with:

- **Frontend**: React/TypeScript SPA with Vite + Tailwind
- **Backend**: Supabase Edge Functions (Deno) + Deno Deploy edge functions
- **Database**: PostgreSQL (via Supabase)
- **Story / Prompt LLMs**: DeepSeek, Claude Sonnet 4.6, Claude Opus 4.6
- **Image Models** (current line-up):
  - `flux-2-dev` (Spark / Entry — 7K tokens)
  - `imagen-4-fast` (Standard — 14K tokens)
  - `grok-imagine-image` (Grok — 16K tokens)
  - `gpt-image-1-mini` (Plus — 30K tokens)
  - `seedream-4.5` (Prime — 35K tokens, recommended)
  - `imagen-4-ultra` (Premium — 42K tokens)
  - `nano-banana-pro` (Genesis — 100K tokens)
- **TTV Video Models**: Wan 2.2, Seedance 1.0 Pro Fast, LTX 2.3 Fast, Grok (480p / 720p high-res), Seedance 1.5 Pro, Veo 3.1 Fast, LTX 2.3 Pro, Veo 3.1, Sora 2 Pro (720p / 4K high-res)
- **ITV Video Models** (all routed via fal.ai): Wan 2.2 ITV, Seedance 1.0 Fast, Hailuo 2.3 Fast, Seedance 1.5 Pro ITV, LTX 2.3 Fast ITV, Veo 3.1 Fast ITV, LTX 2.3 Pro ITV, Veo 3.1 ITV, LTX 2.3 Pro 4K ITV
- **Motion Graphics (MG)**: AI codegen pipeline — Claude Opus / Sonnet 4.6 generates bespoke [Remotion](https://www.remotion.dev) `Clip.tsx` files per text segment, rendered on AWS Lambda (`remotion-render-4-0-458`, `eu-north-1`) with per-job S3 deploy sites. 16 curated style presets (Cinematic Dark, Realistic Map, Voxel Pixel People, Hyperreal 3D, Bright Infographic, Glassmorphism, Kinetic Typography, Brutalist Newspaper, etc.) plus freeform custom style direction.
- **Voice Providers**: ModelLab (v6/v7 — Standard, Core, Premium, Apex tiers), LemonFox, Speechify, Inworld AI (predefined + custom voice cloning), **ElevenLabs** (voice browser with multiple ElevenLabs models)
- **Storage**: Supabase Storage with TUS-resumable chunked uploads
- **Media Processing**: Google Cloud Functions (Python, FFmpeg/MoviePy/Pydub) for final video assembly, transitions and effects

**Removed / legacy models** (no longer selectable): DALL·E, Stable Diffusion, ModelsLab Wan (replaced by fal.ai Wan 2.2). Older Imagen 3 / GPT Image 1 (full) tiers were consolidated into the line-up above.

---

## V2 Updates & New Features

### Master Prompt System

**What's New**: Enhanced visual and narrative consistency across all generated content.

**Key Features**:

- **16+ Predefined Visual Styles**: Old Comic Book, Medieval Oil Painting, Studio Ghibli, Pixel Art, Realistic Animation, and more
- **Custom Style Input**: Define unique visual aesthetics
- **Setting Configuration**: Detailed world-building and environment setup
- **Atmosphere & Mood**: Emotional tone and pacing guidelines
- **Character Management**: Define multiple characters with descriptions
- **Environment-Only Mode**: Focus solely on settings without character details
- **AI Enhancement**: Optional AI-powered expansion of basic prompts into comprehensive guidelines

**Database Changes**:

- `story_tasks.master_prompt` (text): Stores enhanced master prompt for story generation
- `tabs.master_prompt` (jsonb): Tab-specific master prompt configuration
- `tabs.master_prompt_enhance_ai` (boolean): Whether to use AI enhancement
- `video_tasks.master_prompt` (text): Master prompt for video pipeline
- `image_prompt_context.master_prompt_data` (jsonb): Master prompt for image generation context
- `image_prompt_context.environment_only_mode` (boolean): Environment-only flag

**Backend Functions**:

- `master-prompt.ts` (Deno Deploy): Enhances basic prompts with AI-generated details

### Runtime Mode (Story Generator)

**What's New**: Toggle between word count and runtime (minutes) modes for story generation.

**Features**:

- **Word Count Mode** (Traditional): Specify exact word count (500-150,000 words)
- **Runtime Mode** (NEW): Specify desired audio runtime in minutes
  - Automatically calculates optimal word count using 7,500 words per 60 minutes ratio
  - Example: 30-minute runtime = ~3,750 words
- Seamless toggle switch in UI
- Estimates are saved per tab

**Database Changes**:

- `tabs.is_runtime_mode` (boolean): True = runtime mode, False = word count mode
- `tabs.runtime_minutes` (integer): Target runtime in minutes

### Image Frequency Modes

**What's New**: Two distinct modes for controlling image generation frequency.

**Word Count Mode** (Traditional):

- **Variable Frequency**: Different intervals for first page (15-60s) vs. rest (10-90s)
- **Consistent Frequency**: Same interval (5-900s) throughout entire story
- Based on reading speed calculation (13.67 characters per second)

**Audio Runtime Mode** (NEW):

- **Prerequisite**: Audio must be generated, uploaded, or duration estimated
- **Consistent Distribution**: Evenly distribute N images across total audio duration
  - Example: 20 images over 30 minutes = 1 image every 90 seconds
- **Variable Distribution**: Specify image counts for first page and rest of content
  - Example: 5 images for first 3 minutes, 15 images for remaining 27 minutes
- **Audio Duration Calculation**: Automatic extraction from WAV/MP3 files
- **Perfect Sync**: Images timed to audio narration for video generation

**Database Changes**:

- `tabs.frequency_mode` (varchar): 'wordcount' or 'audio'
- `tabs.frequency_type` (varchar): 'variable' or 'consistent'
- `tabs.consistent_frequency` (integer): Seconds per image (consistent mode)
- `tabs.audio_distribution_type` (varchar): 'consistent' or 'variable' (audio mode)
- `tabs.first_page_image_amount` (integer): Image count for first page (audio, variable)
- `tabs.rest_image_amount` (integer): Image count for rest (audio, variable)
- `tabs.total_audio_duration` (numeric): Calculated audio duration in seconds
- `tabs.image_amount` (integer): Total images (audio, consistent)
- `story_documents.audio_duration` (numeric): Duration of audio narration
- Similar fields added to `video_tasks` table

**Backend Functions**:

- `calculate-audio-duration.ts` (Deno Deploy): Extracts duration from audio files
- Enhanced `storyscriptai-setup-prompt.ts`: Supports both frequency modes

### Image Prompt Context System

**What's New**: Centralized context storage for image prompt generation with master prompt integration.

**Features**:

- **Full Story Context**: Complete story text stored once per group (not per batch)
- **Master Prompt Integration**: Visual style and character consistency across all prompts
- **Character Caching**: Pre-extracted character descriptions for faster generation
- **Environment-Only Support**: Atmospheric prompts without character references
- **Reduced Redundancy**: Eliminates duplicate data storage across batches

**Database Changes**:

- NEW `image_prompt_context` table with fields:
  - `group_id` (uuid): Links to image_prompt_tasks
  - `full_story_text` (text): Complete story for context
  - `word_count`, `character_count` (integer): Text statistics
  - `master_prompt_data` (jsonb): Visual style, setting, atmosphere, characters
  - `environment_only_mode` (boolean): Exclude character details
  - `style_description` (text): Visual style guidelines
  - `character_descriptions` (jsonb): Extracted character profiles
- `image_prompt_tasks.image_prompt_document_id` (uuid): Reference to final prompts document

**Workflow**:

1. User initiates image prompt generation
2. System creates `image_prompt_context` entry with full story + master prompt
3. Each batch retrieves context from centralized table
4. AI generates prompts with consistent visual and narrative guidelines
5. Final prompts compiled and stored with document reference

### Visual Pipeline: Image, TTV & ITV (NEW)

**What's New**: The Video Generator pipeline now supports three independent **visual types** in Step 2 (Visual Configuration). The same orchestrator can produce a finished video from any of them, with one consistent audio + final-render path.

**Visual Types** (`tabs.visual_type` / `video_tasks.visual_type`):

- `image` \u2014 Classic image-prompt \u2192 image-generation \u2192 Ken-Burns / animation pipeline
- `ttv` \u2014 **Text-to-Video**: text segments \u2192 cinematic video prompts \u2192 AI video clips (no intermediate image)\n- `itv` \u2014 **Image-to-Video**: text \u2192 keyframe image prompts \u2192 keyframe images \u2192 motion prompts \u2192 animated video clips\n\n**Standalone pages** also exist for each visual type so users can run them on their own without going through the full video pipeline:\n\n- `/text-to-video` \u2014 `TextToVideoGenerator.tsx`\n- `/image-to-video` \u2014 `ImageToVideoGenerator.tsx`\n- `/video` \u2014 `VideoGenerator.tsx` (full orchestrator)\n\n**TTV Models** (9 tiers): Wan 2.2 \u2192 Seedance 1.0 Pro Fast \u2192 LTX 2.3 Fast \u2192 Grok (with optional 720p high-res) \u2192 Seedance 1.5 Pro \u2192 Veo 3.1 Fast \u2192 LTX 2.3 Pro \u2192 Veo 3.1 \u2192 Sora 2 Pro (with optional 4K high-res). Several models support an optional **embedded audio clip** at \u22481.5\u20132\u00d7 token cost.\n\n**ITV Models** (9 tiers, all via fal.ai): Wan 2.2 ITV \u2192 Seedance 1.0 Fast \u2192 Hailuo 2.3 Fast \u2192 Seedance 1.5 Pro ITV \u2192 LTX 2.3 Fast ITV \u2192 Veo 3.1 Fast ITV \u2192 LTX 2.3 Pro ITV \u2192 Veo 3.1 ITV \u2192 LTX 2.3 Pro 4K ITV (2160p).\n\n**Database Changes** (summary, see per-section schemas for full lists):\n\n- New tables: `TTV_prompt_context`, `TTV_prompt_tasks`, `TTV_tasks`, `ITV_prompt_context`, `ITV_prompt_tasks`, `ITV_tasks`, `job_data`\n- `video_tasks` adds: `visual_type`, `process_ttv`, `video_model`, `video_duration`, `audio_clip`, `ttv_prompt_status/progress`, `ttv_status/progress`, `ttv_prompt_document_id`, `ttv_folder_document_id` (plus equivalent ITV fields)\n- `tabs` adds: `visual_type`, `process_ttv`, `video_model`, `video_duration`, `audio_clip`\n- `story_documents` adds: `audio_clip`, `pauses`, `audio_duration`\n- New version codes used in `story_documents`: 12/13 (TTV prompts), 14/15 (TTV video folder), 16/17 (ITV image prompts), 20/21 (ITV motion prompts), 22/23 (ITV video folder)\n\n**New Backend Functions** (Deno Deploy + Supabase Edge):\n\n- TTV: `setup-ttv-prompts`, `process-ttv-task`, `setup-TTV-tasks`, `generate-TTV-prompt`, `process-TTV-prompt`, `generate-TTV`, `process-TTV`, `trigger-next-TTV`, `trigger-next-TTV-prompt`, `redo-TTV`, `single-TTV`, `empty-redo-TTV`\n- ITV: `setup-itv-prompts`, `process-itv-task`, `setup-ITV-tasks`, `generate-ITV-prompt`, `process-ITV-prompt`, `generate-ITV`, `process-ITV`, `trigger-next-ITV`, `trigger-next-ITV-prompt`, `redo-ITV`, `single-ITV`, `empty-redo`\n- Pipeline planning: `plan-video.ts` (Deno Deploy) coordinates the visual pipeline choice\n\n### Single-Prompt Video Generation (NEW)\n\n**What's New**: Each visual generator now exposes a **single-prompt mode** for one-shot generation \u2014 no story document required.\n\n- **Single Image** (`single-image` edge function): Generates one image directly from a user prompt using any image model.\n- **Single TTV** (`single-TTV` edge function): Generates one text-to-video clip from a user prompt using any TTV model. Tracked with `single_ttv = true` on the corresponding `TTV_tasks` row.\n- **Single ITV** (`single-ITV` edge function): Chained from `single-image` \u2014 first creates the keyframe, then animates it into a single ITV clip.\n- **One-prompt full video** in `VideoGenerator.tsx`: A user can type a single description, and the orchestrator runs the entire chain (story \u2192 prompts \u2192 visuals \u2192 audio \u2192 final MP4) automatically. Internally this uses the same `process_story` / `process_images` / `process_audio` flags on `video_tasks` together with the chosen `visual_type`.\n\n**Use cases**:\n\n- Quickly preview what a model produces before running a long batch\n- Generate one promo / hero clip without going through the full pipeline\n- One-prompt-to-video for short-form content where the user doesn\u2019t want to write or upload anything else\n\n### Voice Provider Update (NEW)\n\n**ElevenLabs** has been added as a first-class voice provider alongside ModelLab v6/v7, LemonFox, Speechify and Inworld clones.\n\n- New component: `ElevenLabsVoiceBrowser.tsx` (searchable voice browser + per-model dropdown)\n- New data file: `src/data/elevenlabsModels.ts` (model list with `tokensPerChar` pricing)\n- New edge function: `elevenlabs-list-voices`\n- `VoiceSelector.tsx` exposes a `hideElevenLabs` flag for surfaces that should not show ElevenLabs (e.g. some video pages)\n\n### Component Enhancements\n\n**New Components**:\n\n- `MasterPrompt.tsx` \u2014 Master prompt configuration UI with 16+ predefined styles\n- `ImageFrequencyConfiguration.tsx` \u2014 Dual-mode frequency configuration (word count vs. audio)\n- `VideoModelSelector.tsx` \u2014 9-tier TTV model grid with style preview videos\n- `ITVVideoModelSelector.tsx` \u2014 9-tier ITV model grid with audio-support badges\n- `ImageModelSelector.tsx` \u2014 7-tier image model grid (Spark \u2192 Genesis)\n- `VisualConfiguration.tsx` \u2014 Step 2 visual-type orchestrator (Image / TTV / ITV tabs)\n- `ElevenLabsVoiceBrowser.tsx` \u2014 ElevenLabs voice browser\n- `SubtitleConfiguration.tsx` \u2014 Subtitle overlay configuration\n- `CaptionOverlay.tsx`, `BeforeAfter.tsx`, `BuiltForYouTube.tsx`, `LiveStatsBar.tsx`, `PipelineCanvas.tsx`, `PipelineFlowSVG.tsx`, `Preloader.tsx`, `StatusBanner.tsx`, `TrustSignals.tsx`, `VisualStyleGalleryNew.tsx`, `VoiceShowcase.tsx`, `WelcomeModal.tsx`, `DataTunnelCanvas.tsx`, `LargeVideoDownloadModal.tsx` \u2014 Marketing / UX surface components\n\n**Updated Components**:\n\n- `Generator.tsx` \u2014 Master prompt toggle, runtime mode switch\n- `ImagePrompts.tsx` \u2014 Frequency mode selection, audio duration integration\n- `VideoGenerator.tsx` \u2014 Full pipeline integration with master prompt, audio runtime, visual-type selection (Image / TTV / ITV) and single-prompt entry point\n- `TextToVideoGenerator.tsx`, `ImageToVideoGenerator.tsx` \u2014 Standalone pages with document-mode and single-prompt mode\n- `VoiceSelector.tsx` \u2014 ElevenLabs tier added, optional `hideElevenLabs` flag\n\n---\n\n## Story Generator

### Architecture Overview

The story generator follows a batch-based processing model where long-form stories are broken into manageable chunks (batches) and processed sequentially. This approach allows for:

- Efficient token management across different AI models
- Progress tracking and resumability
- Error recovery at the batch level
- Support for very long stories (10,000+ words)

### Database Schema

#### `story_tasks` Table

The central table tracking all story generation tasks. Each row represents either:

- An outline task (batch_number = 0)
- A story batch task (batch_number ≥ 1)

**Key Fields**:

```
id (uuid)                    - Primary key
user_id (uuid)              - Foreign key to users
group_id (uuid)             - Groups all tasks for a single story generation
batch_number (integer)      - 0 = outline, 1+ = story batches
status (varchar)            - 'pending', 'running', 'completed', 'error', 'stopped'
batch (jsonb)               - Array of chapters to process in this batch
story_title (text)          - Story title
description (text)          - Story description/prompt
outline (text)              - Generated outline (batch_number=0 only)
feedback (text)             - System feedback for corrections
previous_content (text)     - Content from previous batches for context
total_word_count (integer)  - Target word count
total_batches (integer)     - Total number of batches
progress (integer)          - Completion percentage
is_corrected (boolean)      - Whether this is a correction task
version (integer)           - 1 = original, 2 = corrected
variant (integer)           - Story variant number
language (varchar)          - 'english', 'german', 'spanish', 'french'
model (varchar)             - 'deepseek', 'sonnet', 'opus'
tab (integer)               - Tab number (for premium users: elite, ultimate, enterprise)
input_tokens (integer)      - AI tokens consumed (input)
output_tokens (integer)     - AI tokens generated (output)
estimated_tokens (bigint)   - Pre-calculated token estimate
video_process (boolean)     - Whether this is for video generation
stop_requested (boolean)    - User requested cancellation
story_document_id (uuid)    - Reference to final story_documents entry
master_prompt (text)        - Enhanced master prompt for story generation context
```

**Batch Structure** (JSONB field):

```json
[
  {
    "index": 0,
    "number": 1,
    "title": "Chapter Title",
    "part": "Part I",
    "word_count": 800,
    "summary": "Chapter summary for AI context"
  }
]
```

#### `story_documents` Table

Stores completed story documents uploaded to Supabase Storage.

**Key Fields**:

```
id (uuid)                - Primary key
user_id (uuid)          - Foreign key to users
group_id (uuid)         - Links to story_tasks.group_id
file_path (text)        - Path in Supabase Storage
file_url (text)         - Public URL for document
title (text)            - Story title
description (text)      - Story description
word_count (integer)    - Final word count
file_size (bigint)      - File size in bytes
version (integer)       - 1 = original, 2 = corrected
variant (integer)       - Story variant
is_corrected (boolean)  - Whether this is corrected version
is_prompted (boolean)   - Whether image prompts were generated
image_model (varchar)   - Image model used if prompted
language (text)         - Story language
model (text)            - AI model used
tab (integer)           - Tab number
audio_duration (numeric) - Duration of audio narration in seconds (NEW)
```

#### `tabs` Table

Manages multi-tab workspace for premium users (elite, ultimate, and enterprise). Each tab can run an independent generation process.

**Key Fields**:

```
user_id (uuid)              - Foreign key to users
page (varchar)              - 'story', 'audio', 'image', 'video'
tab_number (integer)        - Tab identifier (1-10)
status (varchar)            - 'idle', 'outline', 'generating', 'complete', 'error'
group_id (uuid)             - Current generation group_id
title (varchar)             - Display title
story_description (text)    - User's story prompt
word_count (integer)        - Target word count
language (varchar)          - Generation language
model (varchar)             - AI model selection
estimate_tokens (bigint)    - Estimated token usage

-- Master Prompt fields
master_prompt (jsonb)       - Enhanced master prompt data (visual style, setting, atmosphere, characters)
master_prompt_enhance_ai (bool) - Whether to use AI enhancement for master prompt
is_runtime_mode (bool)      - True = runtime mode, False = word count mode
runtime_minutes (integer)   - Target runtime in minutes (for runtime mode)

-- Audio settings
selected_voice (varchar)
speed (numeric)
volume (numeric)
preference (varchar)        - 'separate' or 'combined' audio
remove_title_chapters (bool)

-- Image settings
style (text)
use_character_descriptions (bool)
first_page_frequency (int)  - Deprecated: Use frequency_mode fields
rest_frequency (int)        - Deprecated: Use frequency_mode fields
image_model (varchar)

-- Image Frequency Mode (V2)
frequency_mode (varchar)    - 'wordcount' or 'audio' (runtime-based)
frequency_type (varchar)    - 'variable' or 'consistent'
consistent_frequency (int)  - Seconds per image (when frequency_type='consistent')
audio_distribution_type (varchar) - 'consistent' or 'variable' (for audio mode)
first_page_image_amount (int) - Number of images for first page (audio mode, variable)
rest_image_amount (int)     - Number of images for rest of content (audio mode, variable)
total_audio_duration (numeric) - Calculated audio duration in seconds
image_amount (int)          - Total number of images to generate (audio mode, consistent)

-- Video settings
video (boolean)
process_story (boolean)
process_images (boolean)
process_audio (boolean)
animation_type (varchar)
effects_type (varchar)
bg_music_url (text)
bg_music_volume (numeric)
...
```

#### `story_comparisons` Table

Stores AI-generated comparisons between original and corrected stories.

**Key Fields**:

```
user_id (uuid)
group_id (uuid)
comparison_text (text)      - Formatted comparison analysis
input_tokens (integer)
output_tokens (integer)
language (varchar)
model (text)
tab (integer)
```

### Frontend Components

#### `GeneratorContainer.tsx`

**Purpose**: Wrapper component managing tab state and Generator component lifecycle.

**Key Responsibilities**:

- Checks enterprise user status
- Manages multiple tab configurations
- Forces Generator remount on tab changes for complete isolation
- Handles tab creation, switching, and cleanup

**State Management**:

```typescript
{
  currentTab: number; // Active tab (1-10)
  isEnterpriseUser: boolean; // Whether user can use tabs
  tabConfigs: Record<
    number,
    {
      // Tab configurations
      groupId: string;
      tab: number;
    }
  >;
}
```

#### `Generator.tsx`

**Purpose**: Main story generation interface with configuration and progress tracking.

**Key Features**:

- **Master Prompt System (Enhanced)**:
  - Toggle to enable enhanced master prompt mode (recommended)
  - Visual Style & Colors: 16+ predefined styles (Old Comic Book, Medieval Oil Painting, Studio Ghibli, Pixel Art, etc.)
  - Setting description: Define the world, time period, and environment
  - Atmosphere & Mood: Set emotional tone and pacing
  - Character definitions: Add character names and descriptions
  - Environment-Only Mode: Focus exclusively on world-building without character details
  - AI Enhancement: Optional AI-powered expansion of basic prompts into detailed guidelines
- **Runtime Mode Toggle**:
  - Switch between Word Count mode and Runtime (minutes) mode
  - Runtime mode automatically estimates word count based on desired audio length
  - Calculates optimal word count using 7,500 words per 60 minutes ratio

- Form inputs for story description, word count/runtime, language, model
- Real-time progress tracking with polling
- Document management (view, download, delete)
- Generation control (start, stop, resume)
- Correction workflow (feedback & rewrite)
- Story comparison functionality
- Tab-aware session storage for form persistence

**State Flow**:

1. User configures story parameters (with optional master prompt)
2. If Master Prompt enabled, system enhances it with AI (if selected)
3. Submits generation request with master prompt context
4. Frontend polls `story_tasks` table for progress
5. AI generates story using enhanced master prompt guidelines
6. Displays real-time status and batch progress
7. On completion, shows document download options

#### `TabManager.tsx`

**Purpose**: UI component for managing multiple generation tabs (elite, ultimate, and enterprise users only).

**Features**:

- Visual tab bar with status indicators
- Color-coded borders: blue (idle), purple (outline), yellow (generating), green (complete), red (error)
- Tab creation (up to 10 tabs)
- Tab deletion with cleanup confirmation
- Token usage estimates per tab
- Real-time status updates via polling

#### `MasterPrompt.tsx`

**Purpose**: Component for configuring enhanced master prompt settings for story generation.

**Features**:

- **16+ Predefined Visual Styles**:
  - Old Comic Book: Black-and-white vintage comic style
  - Medieval Oil Painting: Late medieval/early Renaissance art
  - Studio Ghibli Style: Painterly hand-drawn animation
  - Pixel Art: Retro 8-bit/16-bit aesthetic
  - Realistic Animation: Hyper-realistic CGI style
  - Classical Oil Painting: Baroque-inspired with chiaroscuro
  - Anime Modern Shonen: High-contrast dynamic anime
  - Dreamy Painting: Fantasy art with celestial themes
  - Ink & Wash: Traditional East Asian painting
  - Dark Medieval Fantasy: Gothic and ominous
  - And 6 more styles...

- **Custom Style Input**: Users can enter their own visual style descriptions
- **Setting Configuration**: Detailed world-building and environment setup
- **Atmosphere & Mood**: Define emotional tone and sensory details
- **Character Management**:
  - Add multiple characters with names and descriptions
  - Dynamic character list with add/remove functionality
- **Environment-Only Mode**: Toggle to focus solely on settings without character details
- **AI Enhancement Toggle**: Optional AI expansion of basic prompts into detailed guidelines

**State Management**:

```typescript
interface MasterPromptData {
  visualStyle: string; // Visual style description or predefined style
  setting: string; // World setting and time period
  atmosphere: string; // Emotional tone and mood
  environmentOnly: boolean; // Focus only on environment
  characters: Array<{
    // Character definitions
    name: string;
    description: string;
  }>;
}
```

### Backend Functions

#### Deno Deploy Functions

Located in `/denodeploy/` - These are edge functions deployed on Deno Deploy for low latency.

##### `master-prompt.ts`

**Purpose**: Enhances basic master prompts into comprehensive story generation guidelines using AI.

**Process**:

1. Receives basic master prompt data (visual style, setting, atmosphere, characters)
2. If AI enhancement enabled, calls AI model to expand guidelines
3. Creates detailed profiles for:
   - Enhanced visual style with specific art direction
   - Detailed setting with cultural and environmental elements
   - Nuanced atmosphere with pacing and sensory details
   - Character profiles with personality, appearance, role, and motivations
   - Consistency notes for narrative coherence
4. Returns enhanced prompt structure
5. Stores in `story_tasks.master_prompt` field

**AI Enhancement Prompt**:

```typescript
// Prompts AI to act as creative writing assistant
// Expands basic guidelines into comprehensive master prompt including:
// - Specific visual guidance (colors, cinematography, art direction)
// - Rich setting details (world, locations, cultural elements)
// - Emotional and tonal consistency requirements
// - Detailed character profiles (if not environment-only mode)
// - Narrative consistency guidelines
```

**Enhanced Output Structure**:

```typescript
interface EnhancedMasterPrompt {
  visualStyle: string; // Expanded visual guidelines
  setting: string; // Detailed world-building
  atmosphere: string; // Nuanced emotional guidance
  environmentOnly: boolean; // Whether to exclude characters
  characters: Array<{
    name: string;
    description: string;
    personality?: string; // AI-generated personality traits
    appearance?: string; // AI-generated visual description
    role?: string; // AI-generated narrative role
  }>;
  consistencyNotes: string; // Guidelines for narrative consistency
}
```

**Token Cost**: Uses selected model's token multiplier (DeepSeek 1x, Sonnet 10x, Opus 48x)

##### `storyscriptai-outline.ts`

**Purpose**: Generates story outlines using AI models with optional master prompt context.

**Process**:

1. Receives story description, word count, language, model, and optional master_prompt
2. If master_prompt provided, incorporates it into outline generation prompts
3. Calls appropriate AI model (DeepSeek/Claude) to generate outline
4. Structures outline with chapters, parts, summaries
5. Returns formatted outline text

**AI Prompt Strategy**:

- Requests structured outline with chapter breakdown
- Includes word count targets per chapter
- Adapts prompt based on language
- Uses different prompt strategies for short vs. long stories
- **NEW**: Incorporates master prompt guidelines for visual consistency and character development

**Model Support**:

- DeepSeek: 1,100 words/batch, 1.0x token multiplier
- Sonnet: 3,000 words/batch, 10.0x token multiplier
- Opus: 3,000 words/batch, 48.0x token multiplier

**Circuit Breaker**: Tracks model failures and temporarily disables failing models to prevent cascading failures.

##### `storyscriptai-parse.ts`

**Purpose**: Parses outline text into structured chapters and batches.

**Process**:

1. Receives outline text and group_id
2. Extracts chapters using regex patterns
3. Validates chapter structure (numbers, titles, word counts, summaries)
4. Calculates optimal batch groupings based on model limits
5. Creates batch tasks in `story_tasks` table
6. Updates outline task with batch information
7. Triggers first batch processing

**Batch Creation Logic**:

```typescript
// Accumulate chapters into batches up to model's max words
maxWordsPerBatch = {
  deepseek: 1100,
  sonnet: 3000,
  opus: 3000,
};

// Each batch contains multiple chapters that fit within word limit
// Ensures efficient token usage and processing time
```

**Chapter Validation**:

- Each chapter must have: number, title, word_count, summary
- Word counts must be positive integers
- Summaries provide context for AI continuation
- Part designations (e.g., "Part I") are optional

**Database Operations**:

1. Inserts batch tasks with status 'pending'
2. Updates outline task (batch_number=0) with batch array
3. Calls `trigger-next-batch` function to start processing

#### Supabase Edge Functions

Located in `/supabase/functions/` - These run on Supabase infrastructure with direct database access.

##### `generate-story/`

**Purpose**: Generates story content for a single batch using AI.

**Input Payload**:

```json
{
  "chapters": [
    /* batch chapters */
  ],
  "previous_content": "...",
  "total_word_count": 10000,
  "language": "english",
  "model": "deepseek",
  "is_retry": false,
  "retry_attempt": 0
}
```

**Process**:

1. Validates input parameters
2. Creates appropriate AI client (DeepSeek/Claude)
3. Builds system prompts with:
   - Language-specific instructions
   - Word count targets
   - Context from previous batches
   - Chapter summaries for guidance
4. Streams AI response
5. Validates word count (must be within ±15% of target)
6. Returns generated text + token usage

**System Prompt Engineering**:

- **Context Continuity**: Includes previous content summary for seamless flow
- **Word Count Precision**: Strict word count requirements with retry logic
- **Chapter Structure**: Enforces proper chapter formatting and numbering
- **Language Adaptation**: Adjusts prompts for different languages
- **Retry Strategy**: Reduces target word count by 10% on retries to avoid overlong outputs

**Streaming Support**:

- Uses Server-Sent Events (SSE) for progress updates
- Allows frontend to show generation in real-time
- Reduces perceived latency

**Error Handling**:

- Retries on API failures with exponential backoff
- Falls back to different models if circuit breaker trips
- Validates output quality before accepting

##### `process-story/`

**Purpose**: Orchestrates the processing of a single story batch.

**Process**:

1. Validates input (group_id, user_id, batch_number)
2. Fetches task from `story_tasks` table
3. Checks for stop_requested flag
4. Retrieves previous batch content for context
5. Calls `generate-story` function
6. Updates task with generated content and token usage
7. Updates progress percentage
8. Determines next action:
   - If last batch: triggers final compilation
   - If video process: triggers image prompt generation
   - Otherwise: triggers next batch

**Progress Calculation**:

```typescript
progress = Math.floor((batch_number / total_batches) * 100);
```

**Context Building**:

```typescript
// Fetches all completed batches before current one
// Concatenates their file_paths' content
// Provides AI with full story context up to this point
previous_content = await getPreviousContent(
  userId,
  groupId,
  currentBatchNumber,
);
```

**Final Compilation Trigger**:
When the last batch completes, calls `compile-final-story` which:

1. Concatenates all batch documents
2. Creates final .docx file
3. Uploads to Supabase Storage
4. Inserts record in `story_documents` table
5. Updates all tasks to 'completed_final' status

**Video Workflow Integration**:
If `video_process=true`, after story completion:

1. Triggers image prompt generation
2. Sets up image generation tasks
3. Prepares for audio generation
4. Eventually triggers video compilation

##### `trigger-next-batch/`

**Purpose**: Queues the next pending batch for processing.

**Process**:

1. Validates group_id, user_id, current_batch_number
2. Fetches all tasks for the group
3. Checks for stuck 'running' tasks (updated_at > 10 min ago)
4. Resets stuck tasks to 'error' status
5. **Finds earliest incomplete batch** (not just next sequential)
6. Updates batch status to 'queued'
7. Calls `process-story` function

**Key Improvement**:

```typescript
// OLD: Only checked next sequential batch
const nextBatch = tasks.find((t) => t.batch_number === currentBatchNumber + 1);

// NEW: Finds ANY incomplete batch (handles retries better)
const incompleteBatch = tasks.find(
  (task) =>
    task.batch_number > 0 &&
    (task.status === "pending" ||
      task.status === "error" ||
      task.status === "queued"),
);
```

This allows the system to recover from errors and retry failed batches without manual intervention.

**Completion Detection**:

```typescript
if (currentBatchNumber >= totalBatches && totalBatches > 0) {
  // Check if all batches are complete
  const allComplete = completedTasks.length === totalBatches;
  if (allComplete) {
    return { message: "All batches completed" };
  }
}
```

##### `generate-correction-feedback/`

**Purpose**: Analyzes original story and generates AI feedback for improvement.

**Process**:

1. Fetches outline task (batch_number=0) with original outline
2. Calls AI model with feedback generation prompt
3. AI analyzes outline for:
   - Consistency issues
   - Pacing problems
   - Character development gaps
   - Plot holes
   - Structural improvements
4. Stores feedback in outline task
5. Creates corrected batch tasks (version=2, is_corrected=true)
6. Triggers first corrected batch

**Feedback Prompt Strategy**:

```typescript
// Prompts AI to act as professional editor
// Provides actionable, specific feedback
// Focuses on narrative structure and flow
// Language-aware feedback generation
```

**Corrected Task Structure**:

- Same batch structure as original
- `version=2` (vs. version=1 for original)
- `is_corrected=true`
- `feedback` field populated
- All batches recreated with 'pending' status

##### `generate-corrected-story/`

**Purpose**: Generates improved story content incorporating AI feedback.

**Process**:

1. Similar to `generate-story` but includes feedback context
2. System prompts enhanced with:
   - Original feedback
   - Instructions to address feedback points
   - Maintain consistency with corrections
3. Generates story with improvements
4. Returns corrected text + token usage

**Key Difference from Original**:

```typescript
// Original: Only uses previous_content for context
// Corrected: Uses previous_content + feedback

messages = [
  {
    role: "user",
    content: `
      Feedback to address: ${feedback}
      Previous content: ${previous_content}
      Chapters to write: ${chapters}
    `,
  },
];
```

##### `process-corrected-story/`

**Purpose**: Orchestrates corrected story batch processing.

**Process**:

1. Fetches corrected task (is_corrected=true, version=2)
2. Gets previous corrected content
3. Gets feedback from outline task
4. Calls `generate-corrected-story`
5. Updates task and progress
6. Triggers next corrected batch or final compilation

**Completion**:
Creates final corrected document in `story_documents` with:

- `version=2`
- `is_corrected=true`
- Separate file_path from original

##### `trigger-next-corrected-batch/`

**Purpose**: Queues next corrected batch (version=2).

**Process**:

- Same logic as `trigger-next-batch`
- Filters for `is_corrected=true` and `version=2`
- Calls `process-corrected-story` instead of `process-story`

##### `compare-stories/`

**Purpose**: Generates AI comparison between original and corrected stories.

**Input**:

```json
{
  "doc1": "original story text",
  "doc2": "corrected story text",
  "user_id": "uuid",
  "group_id": "uuid",
  "language": "english",
  "model": "deepseek",
  "tab": 1
}
```

**Process**:

1. Calls DeepSeek with both story versions
2. AI analyzes differences in:
   - **Narrative Structure**: Flow and pacing changes
   - **Character Development**: Depth and consistency
   - **Plot**: Coherence and engagement
   - **Writing Quality**: Style, dialogue, descriptions
   - **Consistency**: Internal logic and continuity
3. Generates structured comparison report
4. Stores in `story_comparisons` table
5. Returns formatted analysis

**Output Format**:

```markdown
## Overall Assessment

[Summary of key improvements]

## Narrative Structure

[Analysis of structural changes]

## Character Development

[Character arc improvements]

## Plot and Pacing

[Plot coherence and pacing analysis]

## Writing Quality

[Style and prose improvements]

## Consistency and Continuity

[Logical consistency improvements]

## Recommendations

[Further improvement suggestions]
```

### User Workflows

#### Basic Story Generation

1. **User Input**:
   - Enters story description: "A detective story set in 1920s Chicago"
   - Sets word count: 10,000 words
   - Selects language: English
   - Chooses model: DeepSeek
   - Clicks "Generate Story"

2. **Frontend Processing** (Generator.tsx):

   ```typescript
   // Creates new group_id
   const groupId = uuidv4();

   // Calls storyscriptai-outline edge function
   const outline = await generateOutline({
     description: storyDescription,
     wordCount: 10000,
     language: "english",
     model: "deepseek",
     userId,
     groupId,
     tab: 1,
   });
   ```

3. **Outline Generation** (storyscriptai-outline.ts):
   - AI generates structured outline with 12 chapters
   - Each chapter has title, summary, word count (~833 words each)
   - Creates outline task in `story_tasks`:
     ```sql
     INSERT INTO story_tasks (
       user_id, group_id, batch_number,
       story_title, description, outline,
       status, total_word_count, tab
     ) VALUES (...)  -- batch_number=0
     ```

4. **Outline Parsing** (storyscriptai-parse.ts):
   - Parses outline into chapter objects
   - Groups chapters into batches:
     - DeepSeek: max 1,100 words/batch → ~1 chapter per batch
     - Creates 12 batch tasks (batch_number: 1-12)
   - Updates outline task with batch array and total_batches=12
   - Triggers batch 1 processing

5. **Batch Processing Loop**:

   For each batch (1-12):

   a. **trigger-next-batch/** queues batch

   b. **process-story/** orchestrates:
   - Fetches batch task
   - Gets previous content (batches 1-N)
   - Calls **generate-story/**

   c. **generate-story/** creates content:
   - Builds system prompt with context
   - Calls DeepSeek API
   - Generates ~833 word chapter
   - Returns text + tokens

   d. **process-story/** completes:
   - Saves content to Supabase Storage
   - Updates task: file_path, status='completed', tokens
   - Updates progress: (1/12 \* 100) = 8%
   - Triggers next batch

   e. Frontend polls and updates UI:

   ```typescript
   // Every 2 seconds
   const tasks = await getTasks(userId, groupId, tab);
   const progress = tasks.find((t) => t.batch_number === 1)?.progress;
   setProgress(progress); // Shows 8%, 16%, 24%, ..., 100%
   ```

6. **Final Compilation**:
   - After batch 12 completes, `process-story` detects completion
   - Concatenates all 12 batch documents
   - Creates final .docx file: `${groupId}_v1_var1_tab1.docx`
   - Uploads to storage bucket: `story_documents/`
   - Inserts into `story_documents` table:
     ```sql
     INSERT INTO story_documents (
       user_id, group_id, title, description,
       file_path, file_url, word_count,
       version, variant, tab
     ) VALUES (...)
     ```
   - Updates all tasks to 'completed_final'

7. **User Completion**:
   - Frontend detects completion
   - Shows download button
   - User downloads .docx file
   - Can now request correction or comparison

#### Correction Workflow

1. **User Requests Correction**:
   - Clicks "Generate Feedback & Corrected Version"
   - Frontend calls correction function

2. **Feedback Generation** (generate-correction-feedback/):
   - Fetches original outline
   - AI analyzes and provides feedback
   - Creates corrected batch tasks (version=2, is_corrected=true)
   - Stores feedback in outline task
   - Triggers corrected batch 1

3. **Corrected Generation Loop**:
   - Similar to original generation
   - Uses **generate-corrected-story/** instead
   - Includes feedback in prompts
   - Each batch incorporates improvements
   - Progress tracked separately from original

4. **Corrected Completion**:
   - Final corrected document created (version=2)
   - User now has two versions to compare

5. **Comparison**:
   - User clicks "Compare Stories"
   - Frontend fetches both documents
   - Calls **compare-stories/** function
   - AI generates detailed comparison analysis
   - Results stored in `story_comparisons`
   - User views side-by-side analysis

#### Multi-Tab Workflow (Elite, Ultimate, Enterprise)

1. **Tab Initialization**:
   - GeneratorContainer checks premium user status (elite, ultimate, or enterprise)
   - Loads tab configurations from `tabs` table
   - Renders TabManager component

2. **Working Across Tabs**:
   - Tab 1: Generate mystery story (10,000 words, English)
   - User clicks "+ New Tab" → Tab 2 created
   - Tab 2: Generate sci-fi story (5,000 words, Spanish)
   - Both generate simultaneously
   - Each has independent:
     - group_id
     - progress tracking
     - session storage
     - task records (filtered by tab number)

3. **Tab Isolation**:
   - Switching tabs triggers Generator remount (via key prop)
   - Each tab's state completely independent
   - Database queries filtered by tab number
   - Session storage namespaced by tab

4. **Tab Cleanup**:
   - Closing tab triggers cleanup:
     ```typescript
     // Stops any running tasks
     await stopTasks(userId, groupId);
     // Deletes tab record
     await deleteTabFromDB(userId, page, tab);
     // Switches to another tab
     setCurrentTab(1);
     ```

### Token Management

#### Estimation

Before generation, frontend calculates estimated tokens:

```typescript
// From generator.ts
function estimateStoryCredits(wordCount, includeCorrection, model) {
  const multiplier = {
    deepseek: 1.0,
    sonnet: 10.0,
    opus: 48.0,
  }[model];

  const outlineTokens = 1500;
  const storyInputTokens = wordCount * 1.33 * 3; // context multiplier
  const storyOutputTokens = wordCount * 1.33;

  // If correction included
  if (includeCorrection) {
    feedbackTokens = 1200;
    correctedInputTokens = storyInputTokens;
    correctedOutputTokens = storyOutputTokens;
  }

  // Convert to credits (0.25 input + 1.0 output)
  return totalCredits * multiplier;
}
```

#### Tracking

Each function records actual token usage:

```typescript
// In generate-story/
const result = await callModelAPI(client, messages, options, model);
const inputTokens = result.usage.prompt_tokens;
const outputTokens = result.usage.completion_tokens;

// Update task
await supabase
  .from("story_tasks")
  .update({ input_tokens: inputTokens, output_tokens: outputTokens })
  .eq("id", taskId);

// Update user's total token usage
await updateUserTokenUsage(userId, inputTokens, outputTokens, model);
```

#### Credit Deduction

Tokens are converted to credits based on model:

- DeepSeek: 1.0x multiplier (cheap)
- Sonnet: 10.0x multiplier (moderate)
- Opus: 48.0x multiplier (expensive)

Formula: `credits = (inputTokens * 0.25 + outputTokens) * multiplier`

### Error Handling & Recovery

#### Automated Stuck Task Recovery (Cron Jobs)

The platform uses PostgreSQL cron jobs that run every **20 minutes** to automatically detect and reset stuck tasks. This system uses a two-phase check to prevent false positives:

**Phase 1 (First 20-minute check)**: Mark task with `check_stuck = TRUE`
**Phase 2 (Second 20-minute check)**: If still stuck, reset to `pending`/`queued` and retry

**Cron Functions**:

- `check_stuck_story_tasks()` - Monitors story generation
- `check_stuck_corrected_story_tasks()` - Monitors story corrections
- `check_stuck_tasks()` - Monitors audio generation (audio_tasks table)
- `check_stuck_image_prompt_tasks()` - Monitors image prompt generation
- `check_stuck_image_tasks()` - Monitors image generation
- `check_stuck_video_tasks()` - Monitors video creation

**How It Works**:

```sql
-- Cron job runs every 20 minutes
-- Example: check_stuck_story_tasks()

-- Phase 1: Mark potentially stuck tasks
UPDATE story_tasks
SET check_stuck = TRUE, updated_at = NOW()
WHERE status = 'running'
  AND check_stuck = FALSE
  AND updated_at <= NOW() - INTERVAL '20 minutes';

-- Phase 2: Reset confirmed stuck tasks (runs in next cron cycle)
UPDATE story_tasks
SET status = 'pending', check_stuck = FALSE, error = NULL
WHERE status = 'running'
  AND check_stuck = TRUE
  AND updated_at <= NOW() - INTERVAL '20 minutes';

-- Then trigger edge function to retry
PERFORM net.http_post(
  url := 'https://.../functions/v1/trigger-next-batch',
  body := jsonb_build_object('group_id', group_id, 'user_id', user_id, ...)
);
```

**Recovery Timeline**:

- Task gets stuck: 0 minutes
- First cron check: +20 minutes (marked with `check_stuck = TRUE`)
- Second cron check: +40 minutes (reset to pending and retried)
- Maximum recovery time: **40 minutes**

#### Retry Logic

```typescript
// In generate-story/
let retryAttempt = 0
const MAX_RETRIES = 3

while (retryAttempt < MAX_RETRIES) {
  try {
    const result = await callModelAPI(...)
    return result
  } catch (error) {
    retryAttempt++
    if (retryAttempt >= MAX_RETRIES) throw error

    // Exponential backoff
    await sleep(1000 * Math.pow(2, retryAttempt))
  }
}
```

#### Circuit Breaker

```typescript
// In storyscriptai-outline.ts
const CIRCUIT_BREAKER_STATE = {
  deepseek: { failures: 0, lastFailure: 0, isOpen: false },
  sonnet: { failures: 0, lastFailure: 0, isOpen: false },
  opus: { failures: 0, lastFailure: 0, isOpen: false },
};

function checkCircuitBreaker(model) {
  const state = CIRCUIT_BREAKER_STATE[model];
  if (state.isOpen) {
    // Check if timeout has passed (5 minutes)
    if (Date.now() - state.lastFailure > 300000) {
      state.isOpen = false;
      state.failures = 0;
    } else {
      throw new Error(`Circuit breaker open for ${model}`);
    }
  }
}

function recordCircuitBreakerFailure(model) {
  const state = CIRCUIT_BREAKER_STATE[model];
  state.failures++;
  state.lastFailure = Date.now();

  if (state.failures >= 3) {
    state.isOpen = true;
    console.log(`Circuit breaker tripped for ${model}`);
  }
}
```

#### User-Initiated Stop

```typescript
// In process-story/
const { data: task } = await supabase
  .from("story_tasks")
  .select("stop_requested")
  .eq("id", taskId)
  .single();

if (task.stop_requested) {
  await supabase
    .from("story_tasks")
    .update({ status: "stopped" })
    .eq("group_id", groupId);

  return { message: "Generation stopped by user" };
}
```

### Performance Optimizations

1. **Batch Size Optimization**: Different models have different context windows:
   - DeepSeek: 1,100 words/batch (smaller context, faster processing)
   - Claude: 3,000 words/batch (larger context, fewer batches)

2. **Streaming Responses**: AI responses stream to reduce latency perception

3. **Parallel Processing**: Frontend polls multiple endpoints simultaneously

4. **Edge Function Deployment**: Deno Deploy functions run close to users

5. **Database Indexing**: Indexes on (user_id, group_id, batch_number, tab)

6. **Storage Optimization**: Documents stored in Supabase Storage, not database

### Monitoring & Debugging

#### Frontend Logging

```typescript
console.log(`[Generator] Starting generation for group ${groupId}`);
console.log(`[Generator] Batch ${batchNumber}/${totalBatches} completed`);
console.log(`[Generator] Progress: ${progress}%`);
```

#### Backend Logging

```typescript
// In process-story/
console.log(`Processing batch ${batchNumber} for group ${groupId}`);
console.log(`Previous content length: ${previousContent.length}`);
console.log(`Generated ${wordCount} words (target: ${targetWordCount})`);
console.log(`Tokens used: ${inputTokens} in, ${outputTokens} out`);
```

#### Database Queries

```sql
-- Check task status
SELECT batch_number, status, progress, error
FROM story_tasks
WHERE group_id = 'xxx' AND tab = 1
ORDER BY batch_number;

-- Check token usage
SELECT SUM(input_tokens), SUM(output_tokens)
FROM story_tasks
WHERE user_id = 'xxx' AND created_at > NOW() - INTERVAL '1 day';

-- Find stuck tasks (handled automatically by check_stuck_story_tasks cron)
SELECT *
FROM story_tasks
WHERE status = 'running'
  AND updated_at < NOW() - INTERVAL '20 minutes';
```

---

## Text-to-Speech Generation

### Architecture Overview

The text-to-speech system converts story documents into professional audio narration using multiple AI voice providers. Like the story generator, it uses a batch-based processing model to handle long documents efficiently. The system supports:

- Multiple voice providers (ModelLab v6/v7, LemonFox, Speechify, voice cloning)
- Custom voice cloning with sample audio
- Separate or merged audio output
- Volume boosting and audio enhancement
- Integration with video generation pipeline

### Database Schema

#### `audio_tasks` Table

Tracks all audio generation tasks with a similar structure to `story_tasks`. Each row represents either a single audio chunk or the final compilation task.

**Key Fields**:

```
id (uuid)                       - Primary key
user_id (uuid)                  - Foreign key to users
group_id (uuid)                 - Groups all tasks for a single audio generation
doc_id (uuid)                   - Reference to story_documents
batch_number (integer)          - 0 = final compilation, 1+ = audio chunks
status (varchar)                - 'pending', 'running', 'completed', 'error', 'stopped'
batch (jsonb)                   - Text chunks to process
text_part (text)                - Specific text for this chunk
file_path (text)                - Path to generated audio file
story_title (text)              - Story title for context
description (text)              - Story description
total_batches (integer)         - Total number of audio chunks
total_prompts (integer)         - Total text segments
progress (integer)              - Completion percentage
model_version (varchar)         - 'v6', 'v7', 'lemonfox', 'speechify', 'clone'
voice (varchar)                 - Voice ID or name
language (varchar)              - Audio language
speed (numeric)                 - Playback speed (0.5-2.0 or 0.5-4.0 for LemonFox)
volume (numeric)                - Volume multiplier (1.0-8.0)
preference (varchar)            - 'separate' or 'merged' output
single_audio (boolean)          - Whether to create single merged file
video_process (boolean)         - Whether this is for video generation
remove_title_chapters (boolean) - Strip chapter titles from text
folder_timestamp (text)         - Folder for audio files
variant (integer)               - Story variant
version (integer)               - Story version
is_corrected (boolean)          - Whether using corrected story
tokens (integer)                - API tokens consumed
stop_requested (boolean)        - User requested cancellation
tab (integer)                   - Tab number

-- Voice cloning fields
is_clone_voice (boolean)        - Whether using cloned voice
clone_voice_name (varchar)      - Custom voice name
clone_voice_url (text)          - Sample audio URL
clone_language (varchar)        - Clone voice language
```

**Batch Structure** (JSONB field):

```json
["First text chunk...", "Second text chunk...", "Third text chunk..."]
```

### Frontend Components

#### `TextToSpeechContainer.tsx`

**Purpose**: Wrapper managing tab state and TextToSpeech component lifecycle.

**Similar to GeneratorContainer**:

- Manages multiple audio generation tabs for premium users (elite, ultimate, enterprise)
- Forces component remount on tab changes for isolation
- Handles tab creation, switching, and cleanup

**State Management**:

```typescript
{
  currentTab: number; // Active tab (1-10)
  isEnterpriseUser: boolean; // Tab feature access
  tabConfigs: Record<
    number,
    {
      // Tab configurations
      groupId: string;
      tab: number;
    }
  >;
}
```

#### `TextToSpeech.tsx`

**Purpose**: Main audio generation interface with document selection and voice configuration.

**Key Features**:

- **Mode Selection**:
  - Document mode: Convert existing story document
  - Raw text mode: Convert pasted text directly
- **Document Browser**: Lists user's story_documents with filters
- **Voice Configuration**:
  - Voice provider selection (ModelLab v6/v7, LemonFox, Speechify, Clone)
  - Voice picker from 100+ voices
  - Custom voice cloning with audio upload
  - Speed adjustment (0.5x - 2.0x, up to 4.0x for LemonFox)
  - Volume boost (1.0x - 8.0x)
- **Output Options**:
  - Separate files (one per chunk)
  - Single merged file
  - Chapter title removal
- **Progress Tracking**:
  - Real-time batch progress with polling
  - Status indicators and error handling
- **Audio Preview**: Built-in player for generated audio
- **Download Management**: Download individual or all audio files

**State Flow**:

1. User selects document or enters text
2. Configures voice, speed, volume, preferences
3. Clicks "Generate Audio"
4. Frontend polls audio_tasks for progress
5. Displays completion and download options

#### `VoiceSelector.tsx`

**Purpose**: Comprehensive voice selection and management component.

**Voice Categories**:

1. **Standard Voices** (19 voices): Basic ModelLab voices
   - henry, nova, madison, adam, michael, bella, etc.
   - Color-coded UI badges

2. **Core Voices** (28 voices): Enhanced ModelLab voices
   - lewis, george, fable, daniel, lily, isabella, etc.
   - Better quality and emotional range

3. **Premium Voices** (50+ voices): High-quality multilingual voices
   - Alex, Ashley, Craig, Elizabeth, Julia, etc.
   - Support for multiple languages and accents
   - Higher token cost

4. **Apex Voices** (7 voices): Ultra-premium voices
   - Highest quality and most natural
   - Premium pricing

5. **Clone Voices**: Custom voice cloning
   - **Predefined Clones**: Declan, Adrian, Alfred, Conrad, Hugo, Ryder, Victor
   - **Custom Upload**: User uploads 30-90 second voice sample
   - Creates personalized voice ID via Inworld AI

**Voice Cloning Process**:

```typescript
// User uploads audio file
1. Upload to Supabase Storage
2. Call Inworld API to create voice clone
3. Receive workspace voice_id
4. Store in clone_voices table
5. Available for immediate use
```

**Features**:

- Search and filter by voice type
- Audio preview for each voice
- Language-specific voice filtering
- Custom voice management (delete, rename)
- Visual indicators for voice types

### Backend Functions

#### Supabase Edge Functions

##### `setup-audio-tasks/`

**Purpose**: Initializes audio generation by splitting document into processable chunks.

**Input Payload**:

```json
{
  "user_id": "uuid",
  "group_id": "uuid",
  "file_path": "story_documents/...",
  "story_title": "Story Title",
  "description": "Description",
  "doc_id": "uuid",
  "variant": 1,
  "voice": "henry",
  "language": "english",
  "model_version": "v6",
  "speed": 0.8,
  "preference": "merged",
  "remove_title_chapters": true,
  "volume": 1.0,
  "videoProcess": false,
  "single_audio": true,
  "clone_voice_name": "Custom Voice",
  "clone_voice_url": "https://...",
  "clone_language": "english",
  "tab": 1
}
```

**Process**:

1. Downloads document from Supabase Storage
2. Cleans text:
   - Removes markdown formatting (`*`, `**`)
   - Optionally removes chapter titles
   - Filters empty lines
   - Strips chapter number lines
3. Splits text into chunks based on model limits:
   - **v6**: 1,000 chars per chunk
   - **v7**: 3,000 chars per chunk
   - **LemonFox**: 1,000 chars per chunk
   - **Speechify**: 1,000 chars per chunk
4. Creates audio_tasks for each chunk (batch_number 1-N)
5. Creates final compilation task (batch_number 0)
6. Triggers first batch processing

**Text Splitting Logic**:

```typescript
// Find natural break points (sentence endings)
function splitText(content: string, maxChars: number): string[] {
  const chunks = [];
  let start = 0;

  while (start < content.length) {
    let end = start + maxChars;

    // Find sentence boundary
    if (end < content.length) {
      const lastPeriod = content.lastIndexOf(". ", end);
      const lastQuestion = content.lastIndexOf("? ", end);
      const lastExclamation = content.lastIndexOf("! ", end);

      const breakPoint = Math.max(lastPeriod, lastQuestion, lastExclamation);

      if (breakPoint > start) {
        end = breakPoint + 2; // Include punctuation and space
      }
    }

    chunks.push(content.substring(start, end).trim());
    start = end;
  }

  return chunks;
}
```

**Batch Creation**:

```sql
INSERT INTO audio_tasks (
  user_id, group_id, batch_number,
  text_part, story_title, description,
  model_version, voice, language, speed,
  preference, volume, single_audio,
  total_batches, total_prompts,
  folder_timestamp, tab, status
) VALUES (...)
```

##### `process-audio/`

**Purpose**: Orchestrates processing of a single audio chunk.

**Process**:

1. Validates input (group_id, user_id, batch_number)
2. Fetches task from audio_tasks
3. Checks for stop_requested flag
4. Calls `generate-audio` function
5. Receives audio file (URL or Base64)
6. Uploads to Supabase Storage
7. Updates task with file_path and token usage
8. Updates progress percentage
9. Determines next action:
   - If last batch: triggers audio compilation
   - Otherwise: triggers next batch

**Note**: Stuck task recovery is handled by the `check_stuck_tasks()` cron job.

**Progress Calculation**:

```typescript
progress = Math.floor((batch_number / total_batches) * 100);
```

**Audio Storage Path**:

```
audio_files/{user_id}/{folder_timestamp}/audio_{batch_number}.wav
```

**Video Integration**:
When all audio batches complete and `video_process=true`:

1. Checks if video flag is set
2. Triggers video setup if all video prerequisites met
3. Coordinates with image and story tasks

**Token Tracking**:

```typescript
// Different providers have different token costs
const tokensPerWord = {
  v6: 1.0,
  v7: 1.5,
  lemonfox: 2.0,
  speechify: 1.8,
  clone: 3.0,
};

// Update user's total token usage
await updateUserTokenUsage(userId, tokens);
```

##### `generate-audio/`

**Purpose**: Generates audio for a single text chunk using selected voice provider.

**Input**:

```json
{
  "prompt": "Text to convert to speech",
  "voice_id": "henry",
  "language": "english",
  "speed": 0.8,
  "model_version": "v6",
  "volume": 1.0,
  "clone_voice_name": "Custom",
  "clone_voice_url": "https://...",
  "clone_language": "english"
}
```

**Voice Provider Integration**:

**1. ModelLab (v6/v7)**:

```typescript
// Call ModelLab API
const response = await fetch("https://api.modellab.io/v1/audio/generate", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${modelLabApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    text: prompt,
    voice_id: voiceId,
    language: language,
    speed: speed,
    version: modelVersion,
  }),
});

// Returns job_id for polling
const { job_id } = await response.json();

// Poll for completion
const audioUrl = await fetchAudio(job_id);
```

**2. Inworld AI (Voice Cloning)**:

```typescript
// For predefined clone voices
const workspaceId = "default-ujsa1wysgyitfqg3ixpqka";
const voiceId = `${workspaceId}__${voiceName}`; // e.g., "default-xxx__declan"

// For custom clones, voice already created during upload
// Use the stored voice_id from clone_voices table

const response = await fetch("https://api.inworld.ai/v1/tts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${inworldApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    text: prompt,
    voice_id: voiceId,
    language: cloneLanguage,
    speed: speed,
  }),
});

// Returns base64 audio data
const { audio_base64 } = await response.json();
```

**3. LemonFox**:

```typescript
const response = await fetch("https://api.lemonfox.ai/v1/tts", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${lemonfoxApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    text: prompt,
    voice: voiceId,
    speed: speed, // Supports up to 4.0x
  }),
});
```

**4. Speechify**:

```typescript
const response = await fetch("https://api.speechify.com/v1/audio", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${speechifyApiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    input: prompt,
    voice: voiceId,
    speed: speed,
  }),
});
```

**Polling Mechanism** (for async providers):

```typescript
async function fetchAudio(jobId: string, maxAttempts = 20): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`https://api.modellab.io/v1/audio/fetch`, {
      method: "POST",
      body: JSON.stringify({ job_id: jobId }),
    });

    const data = await response.json();

    if (data.status === "completed") {
      return data.audio_url;
    }

    if (data.status === "failed") {
      throw new Error("Audio generation failed");
    }

    // Wait before next poll (30 seconds)
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }

  throw new Error("Audio generation timeout");
}
```

**Output**:

```json
{
  "audio_url": "https://storage.example.com/audio.wav", // OR
  "audio_base64": "base64EncodedAudio...",
  "tokens": 1500
}
```

##### `trigger-next-audio/`

**Purpose**: Queues the next pending audio batch for processing.

**Process**:

1. Validates group_id, user_id, current_batch_number
2. Fetches all tasks for the group
3. Finds earliest incomplete batch
4. Updates batch status to 'queued'
5. Calls `process-audio` function

**Note**: Stuck task recovery is handled by the `check_stuck_tasks()` cron job that runs every 20 minutes (see Error Handling & Recovery section).

```typescript
if (currentBatchNumber >= totalBatches) {
  const completedCount = tasks.filter(
    (t) => t.batch_number > 0 && t.status === "completed",
  ).length;

  if (completedCount === totalBatches) {
    // All batches complete, trigger compilation
    return { message: "All audio batches completed" };
  }
}
```

##### `audio-analyze/`

**Purpose**: Analyzes audio configuration and calculates token estimates.

**Functionality**:

1. Calculates word count from document
2. Estimates tokens based on:
   - Word count
   - Voice type (standard/core/premium/apex/clone)
   - Model version
3. Checks user's token quota
4. Returns token estimate and availability

**Token Calculation**:

```typescript
function calculateTokens(
  wordCount: number,
  voiceType: string,
  modelVersion: string,
): number {
  const baseTokens = wordCount * 1.5; // Base conversion rate

  const multipliers = {
    standard: 1.0,
    core: 1.2,
    premium: 2.0,
    apex: 3.0,
    clone: 2.5,
  };

  const versionMultipliers = {
    v6: 1.0,
    v7: 1.3,
    lemonfox: 1.5,
    speechify: 1.4,
    clone: 2.0,
  };

  return baseTokens * multipliers[voiceType] * versionMultipliers[modelVersion];
}
```

**Output**:

```json
{
  "estimated_tokens": 25000,
  "word_count": 10000,
  "can_proceed": true,
  "remaining_tokens": 375000,
  "voice_type": "premium"
}
```

#### Deno Deploy Functions

##### `compile-audio.ts`

**Purpose**: Compiles all audio chunks into final output file(s).

**Process**:

1. Fetches all completed audio tasks (batch_number > 0)
2. Downloads each audio file from storage
3. **Volume Boost** (if volume > 1.0):
   - Calls Google Cloud Function for audio enhancement
   - Applies volume multiplier (1.0-8.0x)
   - Replaces original files with boosted versions

4. **Separate Output** (preference = 'separate'):
   - Creates folder with all individual audio files
   - Zips folder for download
   - Uploads to storage: `audio_files/{user_id}/{timestamp}/separate_audio.zip`

5. **Merged Output** (preference = 'merged' or single_audio = true):
   - Merges audio files sequentially
   - Uses `mergeWavBuffers()` or `mergeMp3Buffers()`
   - Creates single audio file
   - Uploads to storage: `audio_files/{user_id}/{timestamp}/merged_audio.wav`

6. Creates document record in `story_documents` table
7. Marks all tasks as 'completed_final'
8. If video_process=true, triggers video creation

**Audio Merging**:

```typescript
function mergeWavBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  // Extract WAV header from first file (44 bytes)
  const first = new Uint8Array(buffers[0]);
  const header = first.subarray(0, 44);

  // Calculate total data size
  const dataLengths = buffers.map((buf) => buf.byteLength - 44);
  const totalDataLength = dataLengths.reduce((a, b) => a + b, 0);

  // Create new buffer with combined data
  const result = new Uint8Array(44 + totalDataLength);
  result.set(header);

  // Update WAV header with new sizes
  const view = new DataView(result.buffer);
  view.setUint32(4, result.length - 8, true); // File size
  view.setUint32(40, totalDataLength, true); // Data size

  // Append all audio data (skip headers)
  let offset = 44;
  for (const buffer of buffers) {
    const data = new Uint8Array(buffer).subarray(44);
    result.set(data, offset);
    offset += data.length;
  }

  return result.buffer;
}
```

**Volume Boost Integration**:

```typescript
// Calls Google Cloud Function
async function applyVolumeBoost(
  userId: string,
  folderPath: string,
  volume: number,
  modelVersion: string,
): Promise<void> {
  const response = await fetch(
    "https://us-central1-project.cloudfunctions.net/boost-audio-volume",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        folder_path: folderPath,
        volume_multiplier: volume,
        model_version: modelVersion,
      }),
    },
  );

  // GCF downloads files, boosts volume, re-uploads
}
```

**Document Creation**:

```sql
INSERT INTO story_documents (
  user_id, group_id, title, description,
  file_path, file_url, word_count,
  version, variant, tab
) VALUES (
  :user_id, :group_id, :title, :description,
  :file_path, :file_url, :word_count,
  :version, :variant, :tab
)
```

##### `single-audio/`

**Purpose**: Generates complete audio in a single operation (for short texts).

**Use Case**: When text is short enough to process without batching.

**Process**:

1. Receives text and voice configuration
2. Calls appropriate voice provider directly
3. Generates audio
4. Uploads to storage
5. Creates document record
6. No batching or task tracking needed

**Advantages**:

- Faster for short texts (< 1000 words)
- No batch coordination overhead
- Immediate results

**Limitations**:

- Cannot be stopped mid-process
- No progress tracking
- Subject to API timeouts for long texts

### User Workflows

#### Basic Audio Generation

1. **User Selects Document**:
   - Navigates to Text-to-Speech page
   - Sees list of story documents
   - Selects document to convert

2. **Voice Configuration**:

   ```typescript
   // User configures settings
   {
     voice: "henry",
     modelVersion: "v6",
     speed: 0.8,
     volume: 1.0,
     preference: "merged",
     removeTitleChapters: true,
     singleAudio: true
   }
   ```

3. **Setup Phase** (setup-audio-tasks):
   - Downloads document: 10,000 word story
   - Cleans text (removes markdown, chapter titles)
   - Splits into chunks:
     - v6 model: ~1000 chars/chunk
     - Results in ~15 chunks
   - Creates 15 audio_tasks (batch 1-15)
   - Creates compilation task (batch 0)
   - Triggers batch 1

4. **Batch Processing Loop**:

   For each batch (1-15):

   a. **trigger-next-audio/** queues batch

   b. **process-audio/** orchestrates:
   - Fetches batch task
   - Extracts text_part
   - Calls **generate-audio/**

   c. **generate-audio/** creates audio:
   - Calls ModelLab API with text + voice
   - Polls for completion (30s intervals)
   - Returns audio URL

   d. **process-audio/** completes:
   - Downloads audio file
   - Uploads to storage
   - Updates task: file_path, status='completed', tokens
   - Updates progress: (1/15 \* 100) = 6.7%
   - Triggers next batch

   e. Frontend polls and updates UI:

   ```typescript
   // Every 2 seconds
   const tasks = await getAudioTasks(userId, groupId, tab);
   const progress = tasks.find((t) => t.batch_number === 1)?.progress;
   setProgress(progress); // Shows 6%, 13%, 20%, ..., 100%
   ```

5. **Audio Compilation** (compile-audio.ts):
   - After batch 15 completes
   - Downloads all 15 audio files
   - Merges into single WAV file
   - Uploads: `audio_files/{userId}/{timestamp}/merged_audio.wav`
   - Creates story_documents record
   - Updates all tasks to 'completed_final'

6. **User Completion**:
   - Frontend detects completion
   - Shows audio player with merged file
   - Download button available
   - Can regenerate with different settings

#### Voice Cloning Workflow

1. **User Uploads Voice Sample**:
   - Clicks "Custom Voice Clone"
   - Uploads 30-90 second audio file
   - File requirements:
     - Clear speech, no background noise
     - Natural speaking pace
     - Good audio quality (no compression artifacts)

2. **Clone Creation**:

   ```typescript
   // Upload to storage
   const { data, error } = await supabase.storage
     .from("voice_samples")
     .upload(`${userId}/${timestamp}_voice.wav`, audioFile);

   // Call Inworld API to create clone
   const response = await fetch("https://api.inworld.ai/v1/voice/clone", {
     method: "POST",
     body: JSON.stringify({
       audio_url: publicUrl,
       language: selectedLanguage,
       name: customVoiceName,
     }),
   });

   const { voice_id } = await response.json();
   // voice_id format: "workspace-id__custom-voice-name"

   // Store in database
   await supabase.from("clone_voices").insert({
     user_id: userId,
     voice_name: customVoiceName,
     voice_id: voice_id,
     language: selectedLanguage,
     file_path: data.path,
   });
   ```

3. **Using Cloned Voice**:
   - User selects custom voice from VoiceSelector
   - Audio generation uses clone_voice parameters:
     ```typescript
     {
       model_version: 'clone',
       voice: voice_id,
       clone_voice_name: 'My Voice',
       clone_voice_url: publicUrl,
       clone_language: 'english'
     }
     ```
   - Generate-audio calls Inworld with custom voice_id
   - Higher token cost (2.5x multiplier)

4. **Voice Management**:
   - View all custom voices
   - Delete voices (removes from DB and storage)
   - Rename voices
   - Test voices with sample text

#### Multi-Tab Audio Workflow (Elite, Ultimate, Enterprise)

1. **Parallel Audio Generation**:
   - Tab 1: Generate audio for 10,000 word novel (voice: henry)
   - Tab 2: Generate audio for 5,000 word story (voice: custom clone)
   - Each tab independent:
     - Separate group_id
     - Separate progress tracking
     - Separate audio_tasks (filtered by tab)

2. **Tab State Isolation**:

   ```typescript
   // Tab 1 state
   {
     groupId: 'uuid-1',
     selectedDoc: 'Document A',
     voice: 'henry',
     progress: 45
   }

   // Tab 2 state (completely separate)
   {
     groupId: 'uuid-2',
     selectedDoc: 'Document B',
     voice: 'custom-voice-id',
     progress: 78
   }
   ```

3. **Resource Management**:
   - Token usage tracked per tab
   - Storage organized by group_id
   - Can stop individual tabs without affecting others

### Voice Provider Comparison

| Provider       | Voices                | Quality   | Speed Range | Languages     | Token Cost | Best For        |
| -------------- | --------------------- | --------- | ----------- | ------------- | ---------- | --------------- |
| ModelLab v6    | 19 standard + 28 core | Good      | 0.5-2.0x    | English       | 1.0x       | General purpose |
| ModelLab v7    | Same as v6            | Better    | 0.5-2.0x    | English       | 1.3x       | Higher quality  |
| Premium Voices | 50+                   | Very Good | 0.5-2.0x    | 15+ languages | 2.0x       | Multilingual    |
| Apex Voices    | 7                     | Excellent | 0.5-2.0x    | English       | 3.0x       | Professional    |
| LemonFox       | 30+                   | Good      | 0.5-4.0x    | English       | 1.5x       | Fast speech     |
| Speechify      | 20+                   | Very Good | 0.5-2.0x    | Multiple      | 1.4x       | Natural sound   |
| Voice Clone    | Unlimited             | Varies    | 0.5-2.0x    | 10+ languages | 2.5x       | Personalized    |

### Performance Optimizations

1. **Chunk Size Optimization**:
   - v6: 1,000 chars (faster processing, more batches)
   - v7: 3,000 chars (fewer batches, better context)
   - Balance between speed and quality

2. **Parallel Provider Calls**:
   - Multiple audio generation requests in parallel
   - Rate limiting per provider
   - Failover to backup providers

3. **Storage Optimization**:
   - WAV format for quality (uncompressed)
   - Automatic cleanup of intermediate files after compilation
   - Efficient merging without re-encoding

4. **Polling Strategy**:
   - Exponential backoff for failed requests
   - Batch status checks (single query for all tasks)
   - Frontend debouncing to reduce API calls

5. **Volume Boost Optimization**:
   - Only applied if volume > 1.0
   - Processed after all audio generated (once)
   - Uses Google Cloud for heavy processing

### Error Handling & Recovery

#### Provider Failures

```typescript
// Retry logic with exponential backoff
async function callProviderWithRetry(provider, payload, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await callProvider(provider, payload)
    } catch (error) {
      if (i === maxRetries - 1) throw error
      await sleep(1000 * Math.pow(2, i))
    }
  }
}

// Fallback to different provider
if (primaryProvider fails) {
  console.log('Primary provider failed, trying fallback')
  return await callFallbackProvider(payload)
}
```

#### Stuck Task Recovery

Stuck tasks are automatically detected and recovered by PostgreSQL cron jobs (see Error Handling & Recovery section). The cron system:

1. Runs every 20 minutes
2. Uses two-phase verification (check_stuck flag)
3. Resets stuck tasks to pending/queued status
4. Automatically triggers retry via edge functions

**Maximum recovery time**: 40 minutes (two 20-minute cron cycles)

**Manual intervention** (if needed):

```typescript
// Manually reset a stuck task
await supabase
  .from("audio_tasks")
  .update({
    status: "pending",
    check_stuck: false,
    error: null,
  })
  .eq("id", task.id);

// Then manually trigger next batch
await fetch("/functions/v1/trigger-next-audio", {
  method: "POST",
  body: JSON.stringify({ group_id, user_id, current_batch_number }),
});
```

#### Voice Clone Cleanup

```typescript
// When user deletes custom voice
async function cleanupCustomVoice(voiceId: string, userId: string) {
  // 1. Delete from clone_voices table
  await supabase
    .from("clone_voices")
    .delete()
    .eq("voice_id", voiceId)
    .eq("user_id", userId);

  // 2. Delete sample audio from storage
  await supabase.storage.from("voice_samples").remove([filePath]);

  // 3. Delete Inworld voice
  await fetch(`https://api.inworld.ai/v1/voice/${voiceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${inworldApiKey}` },
  });

  // 4. Delete any generated audio using this voice
  await supabase.storage.from("audio_files").remove(audioFilesUsingVoice);
}
```

#### User-Initiated Stop

```typescript
// User clicks stop button
await supabase
  .from("audio_tasks")
  .update({ stop_requested: true })
  .eq("group_id", groupId);

// Process-audio checks before each generation
if (task.stop_requested) {
  await supabase
    .from("audio_tasks")
    .update({ status: "stopped" })
    .eq("group_id", groupId);

  return { message: "Audio generation stopped by user" };
}
```

### Token Management

#### Estimation

```typescript
// Before generation starts
function estimateAudioTokens(
  wordCount: number,
  voiceType: string,
  modelVersion: string,
): number {
  const baseRate = 1.5; // tokens per word

  const voiceMultipliers = {
    standard: 1.0,
    core: 1.2,
    premium: 2.0,
    apex: 3.0,
    clone: 2.5,
  };

  const versionMultipliers = {
    v6: 1.0,
    v7: 1.3,
    lemonfox: 1.5,
    speechify: 1.4,
  };

  return Math.ceil(
    wordCount *
      baseRate *
      voiceMultipliers[voiceType] *
      versionMultipliers[modelVersion],
  );
}

// Example: 10,000 word document
// Premium voice + v7 model
// 10000 * 1.5 * 2.0 * 1.3 = 39,000 tokens
```

#### Tracking

```typescript
// Each audio generation returns token usage
const { audio_url, tokens } = await generateAudio(...)

// Update task
await supabase
  .from('audio_tasks')
  .update({ tokens })
  .eq('id', taskId)

// Update user's total
await supabase.rpc('increment_user_tokens', {
  p_user_id: userId,
  p_tokens: tokens
})
```

#### Quota Checking

```typescript
// Before allowing generation
const { data: usage } = await supabase
  .from('user_plans')
  .select('tokens_used, plan_max')
  .eq('user_id', userId)
  .single()

const estimatedTokens = estimateAudioTokens(...)
const remaining = usage.plan_max - usage.tokens_used

if (estimatedTokens > remaining) {
  throw new Error(
    `Insufficient tokens. Need ${estimatedTokens}, have ${remaining}`
  )
}
```

### Integration with Video Pipeline

When `video_process=true`, audio generation coordinates with video creation:

1. **Audio Completion Check**:

   ```typescript
   // In compile-audio.ts
   const allComplete = await checkAllVideoComponentsComplete(userId, groupId);

   if (allComplete.story && allComplete.audio && allComplete.images) {
     await triggerVideoCreation(userId, groupId);
   }
   ```

2. **Audio Duration Calculation** (NEW):

   When audio is generated or uploaded, the system automatically calculates and stores the duration:

   ```typescript
   // In compile-audio.ts
   // Step 1: Call calculate-audio-duration function
   const durationResponse = await fetch(
     "https://calculate-audio-duration.deno.dev",
     {
       method: "POST",
       body: JSON.stringify({
         folderPath: audioFolderPath,
         files: audioFiles.map((f) => ({ path: f, name: path.basename(f) })),
       }),
     },
   );

   const { totalDuration } = await durationResponse.json();

   // Step 2: Update story_documents with audio_duration
   await supabase
     .from("story_documents")
     .update({ audio_duration: totalDuration })
     .eq("id", docId);

   // Step 3: Update video_tasks with total_audio_duration
   await supabase
     .from("video_tasks")
     .update({ total_audio_duration: totalDuration })
     .eq("group_id", groupId);
   ```

   **calculate-audio-duration.ts** (Deno Deploy):
   - Parses WAV/MP3 file headers to extract duration
   - Supports single files or folder of audio files
   - Returns total duration in seconds
   - Used for: Audio Runtime mode in image prompt generation, video sync timing

3. **Audio File Requirements for Video**:
   - Must be merged (single file)
   - WAV or MP3 format
   - Synchronized with image timings
   - Proper duration calculation for video length

4. **Folder Structure**:
   ```
   video_files/{group_id}/
     ├── story.docx
     ├── audio.wav
     ├── images/
     │   ├── image_0001.png
     │   ├── image_0002.png
     │   └── ...
     └── metadata.json
   ```

### Monitoring & Debugging

#### Frontend Logging

```typescript
console.log(`[TextToSpeech] Starting audio generation for group ${groupId}`);
console.log(`[TextToSpeech] Using voice: ${voice}, model: ${modelVersion}`);
console.log(`[TextToSpeech] Batch ${batchNumber}/${totalBatches} completed`);
console.log(`[TextToSpeech] Audio file path: ${filePath}`);
```

#### Backend Logging

```typescript
// In process-audio
console.log(`Processing audio batch ${batchNumber} for group ${groupId}`);
console.log(`Text length: ${textPart.length} characters`);
console.log(`Generated audio: ${audioUrl}`);
console.log(`Tokens used: ${tokens}`);
console.log(`Provider: ${modelVersion}, Voice: ${voice}`);
```

#### Database Queries

```sql
-- Check audio task status
SELECT batch_number, status, progress, error, tokens
FROM audio_tasks
WHERE group_id = 'xxx' AND tab = 1
ORDER BY batch_number;

-- Check audio token usage
SELECT SUM(tokens) as total_tokens
FROM audio_tasks
WHERE user_id = 'xxx'
  AND created_at > NOW() - INTERVAL '1 day';

-- Find stuck audio tasks (handled automatically by check_stuck_tasks cron)
SELECT *
FROM audio_tasks
WHERE status = 'running'
  AND updated_at < NOW() - INTERVAL '20 minutes';

-- Check custom voices
SELECT voice_name, voice_id, language, created_at
FROM clone_voices
WHERE user_id = 'xxx'
ORDER BY created_at DESC;
```

#### Storage Monitoring

```sql
-- Check audio storage usage
SELECT
  user_id,
  COUNT(*) as audio_files,
  SUM(file_size) / (1024*1024) as total_mb
FROM audio_tasks
WHERE file_path IS NOT NULL
  AND status = 'completed'
GROUP BY user_id
ORDER BY total_mb DESC;
```

---

## Image Prompt Generation

### Architecture Overview

The Image Prompt Generation system transforms story documents into detailed image generation prompts by analyzing text segments and creating visual descriptions aligned with the narrative. It processes stories in batches, extracting character descriptions and generating prompts at configurable frequencies.

**Core Workflow**:

1. User selects a story document or uploads a text file
2. Configures frequency mode (Word Count or Audio Runtime)
3. System segments text based on selected frequency settings
4. Optional master prompt data extracted for visual consistency
5. Character descriptions are extracted automatically (optional)
6. Text segments are sent to AI models to generate image prompts
7. Prompts are compiled into a final document for image generation
8. Optionally triggers automatic image generation after completion

**Key Technologies**:

- **Database**: PostgreSQL (Supabase) - `image_prompt_tasks`, `image_prompt_context` tables
- **Backend**: Deno Deploy + Supabase Edge Functions
- **AI Models**: DeepSeek (1.0x), Claude Sonnet 4.5 (10.0x), Claude Opus 4.1 (48.0x)
- **Image Models**: Imagen 4 Fast, GPT Image 1 Mini, Imagen 4 Ultra, Flux 2 Dev, Seedream 4.5, Nano Banana Pro
- **Frontend**: React with TypeScript, custom hooks for state management
- **Storage**: Supabase Storage for story documents and prompt files

**New Features (V2)**:

- **Frequency Modes**: Word Count mode vs. Audio Runtime mode
- **Master Prompt Integration**: Visual style and character consistency across prompts
- **Environment-Only Mode**: Generate prompts focused solely on settings/atmosphere
- **Audio Duration Calculation**: Automatic audio duration estimation for runtime-based image distribution
- **Flexible Image Distribution**: Consistent vs. Variable frequency patterns

---

### Database Schema

#### `image_prompt_context` Table (NEW)

Stores shared context for image prompt generation including full story text, master prompt data, and character descriptions.

**Key Fields**:

```sql
group_id UUID PRIMARY KEY          - Links to image_prompt_tasks.group_id
user_id UUID                       - Foreign key to users
tab INTEGER DEFAULT 1              - Tab number
full_story_text TEXT NOT NULL      - Complete story text for context
word_count INTEGER                 - Total word count
character_count INTEGER            - Total character count
master_prompt_data JSONB           - Master prompt (visual style, setting, atmosphere, characters)
environment_only_mode BOOLEAN DEFAULT false - Whether to exclude character details
style_description TEXT             - Visual style guidelines
character_descriptions JSONB       - Extracted character profiles
video_process BOOLEAN              - Whether this is for video generation
process_image BOOLEAN DEFAULT false - Whether to auto-generate images after prompts
created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
```

**Purpose**:

- Centralizes story context for all batches in a group
- Enables master prompt consistency across all image prompts
- Reduces redundant data storage (no need to duplicate full text per task)
- Supports environment-only mode for atmospheric prompts
- Provides character description caching for faster prompt generation

#### image_prompt_tasks Table (35 Columns)

```sql
CREATE TABLE image_prompt_tasks (
  -- Core Identifiers
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL,
  group_id UUID,
  doc_id UUID,

  -- Story Context
  story_title TEXT NOT NULL,
  description TEXT,
  file_path TEXT,

  -- Batch Management
  batch JSONB NOT NULL,              -- Array of text segments with positions
  batch_number INTEGER NOT NULL,
  total_batches INTEGER,
  total_prompts INTEGER NOT NULL,

  -- Processing State
  status VARCHAR(20) DEFAULT 'pending',
  progress INTEGER DEFAULT 0,
  error TEXT,
  stop_requested BOOLEAN DEFAULT false,
  check_stuck BOOLEAN NOT NULL DEFAULT false,

  -- AI Model Configuration
  model TEXT DEFAULT 'deepseek',     -- 'deepseek', 'sonnet', 'opus'
  language TEXT DEFAULT 'english',   -- Output language

  -- Image Settings
  settings JSONB,                    -- { style, useCharacterDescriptions, firstPageFrequency, restFrequency, characters }
  image_model VARCHAR,               -- Target image generation model
  process_image BOOLEAN NOT NULL DEFAULT false,
  video_process BOOLEAN,

  -- Output
  text_part TEXT,                    -- Partial story text for this batch
  batch_output TEXT,                 -- Generated prompts for this batch

  -- Token Tracking
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  token_updated BOOLEAN DEFAULT false,

  -- Versioning
  version INTEGER DEFAULT 1,
  variant INTEGER,
  is_corrected BOOLEAN DEFAULT false,

  -- Multi-tab Support
  tab INTEGER NOT NULL DEFAULT 1,

  -- Document References (NEW)
  image_prompt_document_id UUID,     -- Reference to final prompts document in story_documents

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

  -- Legacy Fields
  outline TEXT,
  feedback TEXT,
  file_path TEXT                     -- Path to compiled prompts document
);

-- Indexes for performance
CREATE INDEX idx_image_prompt_tasks_group_id ON image_prompt_tasks(group_id);
CREATE INDEX idx_image_prompt_tasks_user_id ON image_prompt_tasks(user_id);
CREATE INDEX idx_image_prompt_tasks_status ON image_prompt_tasks(status);
CREATE INDEX idx_image_prompt_tasks_tab ON image_prompt_tasks(tab);
```

**Key Field Details**:

- `batch`: JSONB array of segments: `[{ text: string, start: number, is_first_page: boolean }, ...]`
- `settings`: JSONB object with generation settings (V2 Enhanced):
  ```json
  {
    "style": "cinematic, realistic",
    "useCharacterDescriptions": true,
    "firstPageFrequency": "30",
    "restFrequency": "20",
    "characters": {
      "John": "tall man, brown hair, blue eyes",
      "Sarah": "young woman, red hair, green eyes"
    },
    "frequencyMode": "wordcount" | "audio",
    "frequencyType": "variable" | "consistent",
    "consistentFrequency": 45,
    "audioDistributionType": "consistent" | "variable",
    "firstPageImageAmount": 5,
    "restImageAmount": 10,
    "imageAmount": 20,
    "totalAudioDuration": 1800
  }
  ```
- `status`: `'pending'` | `'queued'` | `'processing'` | `'completed'` | `'completed_final'` | `'error'` | `'stopped'`
- `model`: Determines AI model and cost multiplier (deepseek=1x, sonnet=10x, opus=48x)
- `image_model`: Maps to backend models (standard→imagen-4-fast, plus→gpt-image-1-mini, premium→imagen-4-ultra, spark→flux-2-dev, prime→seedream-4.5, genesis→nano-banana-pro)
- `process_image`: If true, triggers automatic image generation after prompt completion
- `video_process`: If true, coordinates with video pipeline after completion
- `check_stuck`: Used by monitoring to detect stalled tasks

---

### Frontend Components

#### ImagePromptsContainer

**Purpose**: Wrapper component managing tab state and forcing remounts when switching between premium tabs (elite, ultimate, enterprise).

**Location**: `src/pages/ImagePromptsContainer.tsx`

**Key Responsibilities**:

- Initialize enterprise user status
- Manage tab configurations with `groupId` per tab
- Force complete remount of `ImagePrompts` when tab changes (via `key` prop)
- Handle tab creation, switching, and cleanup
- Ensure Tab 1 exists in database on mount

**State Management**:

```typescript
interface TabConfig {
  groupId: string;
  tab: number;
}

const [currentTab, setCurrentTab] = useState<number>(1);
const [tabConfigs, setTabConfigs] = useState<Record<number, TabConfig>>({
  1: { groupId: "", tab: 1 },
});
```

**Key Features**:

```typescript
// Tab switching triggers complete remount
<ImagePrompts
  key={`image-tab-${currentTab}`}  // Forces remount
  initialTab={currentTab}
  initialGroupId={tabConfigs[currentTab]?.groupId}
  isEnterpriseUser={isEnterpriseUser}
  onTabChange={handleTabChange}
  onTabCreate={handleTabCreate}
  onTabClose={handleTabClose}
/>

// Cleanup on tab close
const handleTabClose = async (tab: number, groupId: string) => {
  const imagePromptsRef = imagePromptsRefs.current[tab];
  if (imagePromptsRef) {
    await imagePromptsRef.cleanup(); // Stops tasks, clears storage
  }
  // Remove from configs, switch to another tab
};
```

#### ImagePrompts

**Purpose**: Main image prompt generation UI with document selection, configuration, and progress tracking.

**Location**: `src/pages/ImagePrompts.tsx`

**State Management** (Tab-Aware Session Storage):

```typescript
// All state uses tab-specific keys
const [documents, setDocuments] = useTabSessionStorage<StoryDocument[]>(
  "imageDocuments",
  [],
  tab,
);
const [selectedDoc, setSelectedDoc] = useTabSessionStorage<string>(
  "imageSelectedDoc",
  "",
  tab,
);
const [generationState, setGenerationState] =
  useTabSessionStorage<GenerationState>("imageGenerationState", "idle", tab);
const [generationSettings, setGenerationSettings] =
  useTabSessionStorage<GenerationSettings>(
    "imageGenerationSettings",
    defaultSettings,
    tab,
  );
```

**Form Configuration**:

```typescript
interface GenerationSettings {
  style: string; // Visual style for prompts
  useCharacterDescriptions: boolean; // Extract character details
  firstPageFrequency: string; // Seconds between images on page 1
  restPageFrequency: string; // Seconds between images on rest of pages
  imageModel: "standard" | "plus" | "premium" | "spark" | "prime" | "genesis";
  language: "english" | "german" | "spanish" | "french";
  model: "deepseek" | "sonnet" | "opus"; // AI model for prompt generation
}
```

**Key Features**:

1. **Document Selection**:
   - Select from existing story documents
   - Upload new .txt/.docx files (max 70,000 words, 1MB)
   - Filters documents by tab if enterprise user
   - Displays word count, version, variant, correction status

2. **Style Configuration**:
   - 800+ predefined styles per image model
   - Categories: Cinematic, Artistic, Realistic, etc.
   - Custom style input option

3. **Character Descriptions**:
   - Automatically extracts character names and descriptions from story
   - Uses AI to identify physical descriptions
   - Stored in `settings.characters` JSONB field
   - Improves consistency across generated images

4. **Frequency Settings (V2 Enhanced)**:

   **Word Count Mode** (Traditional):
   - First page: 15-60 seconds (default 30s)
   - Rest of pages: 10-90 seconds (default 60s)
   - Calculates estimated image count: `estimatedImages = ceil(wordCount / (frequency * 13.67))`
   - Variable frequency: Different intervals for first page vs. rest
   - Consistent frequency: Same interval throughout entire story

   **Audio Runtime Mode** (NEW):
   - Based on audio narration duration instead of word count
   - Requires audio duration calculation (from generated, existing, or uploaded audio)
   - Variable distribution: Specify image counts for first page and rest
   - Consistent distribution: Total images distributed evenly across audio duration
   - Example: 30-minute audio with 20 images = 1 image every 90 seconds
   - Automatically syncs with audio timing for video generation

5. **Model Selection**:
   - Core Model (DeepSeek): 1x token cost
   - Claude Sonnet 4.5: 10x token cost, better quality
   - Claude Opus 4.1: 48x token cost, best quality

6. **Progress Tracking**:

   ```typescript
   const [progress, setProgress] = useState({
     current: 0,
     total: 0,
     percentage: 0,
     statusMessage: "",
   });
   ```

   - Real-time polling every 3 seconds
   - Displays current batch, total batches, percentage
   - Shows detailed status messages
   - Detects stalled tasks (30s without progress)

7. **Error Handling**:
   - Network connectivity checks
   - Retry logic with exponential backoff (max 10 retries)
   - Stall detection and recovery
   - User-friendly error messages
   - Cleanup on errors (removes incomplete tasks)

8. **Token Management**:
   ```typescript
   // Estimate tokens before generation
   const estimatedTokens = calculateEstimatedImageTokens(
     estimatedImageCount,
     imageModel,
   );
   const totalCost = estimatedTokens * modelMultiplier;
   // Check against user balance
   if (totalCost > tokenBalance) {
     throw new Error("Insufficient tokens");
   }
   ```

#### ImageModelSelector

**Purpose**: Dropdown component for selecting image generation model and visual style.

**Location**: `src/components/ImageModelSelector.tsx`

**Supported Models**:

| Model    | Backend Name     | Speed    | Quality  | Style Count |
| -------- | ---------------- | -------- | -------- | ----------- |
| Standard | imagen-4-fast    | Fast     | Good     | 800+        |
| Plus     | gpt-image-1-mini | Medium   | Better   | 800+        |
| Premium  | imagen-4-ultra   | Slow     | Best     | 800+        |
| Spark    | flux-2-dev       | Fast     | Good     | 800+        |
| Prime    | seedream-4.5     | Medium   | Better   | 800+        |
| Genesis  | nano-banana-pro  | Variable | Variable | 800+        |

**Style Categories**: Cinematic, Artistic, Realistic, Vintage, Minimalist, Fantasy, Sci-Fi, Horror, Anime, Abstract, Photography, 3D Render, Watercolor, Oil Painting, Sketch

#### FileUploadComponents (DocumentSelector)

**Purpose**: Component for selecting existing story documents or uploading new files.

**Location**: `src/components/FileUploadComponents.tsx`

**Features**:

- **Document Listbox**: Displays story documents with metadata (title, word count, date, version, variant)
- **File Upload Zone**: Drag-and-drop or click to upload .txt/.docx files
- **Validation**: Checks file size (max 1MB) and word count (max 70,000 words)
- **Word Count Display**: Extracts and displays word count from uploaded files
- **Mutual Exclusivity**: Selecting a document clears uploaded file and vice versa

#### TabManager

**Purpose**: Premium feature for managing multiple image prompt generation tabs simultaneously (elite, ultimate, and enterprise users).

**Location**: `src/components/TabManager.tsx`

**Features** (Same as Story/Audio with `page='image'`):

- Display active tabs with status indicators
- Create new tabs (up to plan limit)
- Close tabs (Tab 1 cannot be closed)
- Token estimation per tab
- Total token count across all tabs
- Status badges: Idle (gray), Outline (yellow), Generating (blue), Complete (green), Error (red)

#### `ImageFrequencyConfiguration.tsx` (NEW)

**Purpose**: Comprehensive component for configuring image generation frequency using either word count or audio runtime modes.

**Location**: `src/components/ImageFrequencyConfiguration.tsx`

**Key Features**:

1. **Frequency Mode Selection**:
   - **Word Count Mode**: Traditional text-based image distribution
   - **Audio Runtime Mode**: Duration-based image distribution synced with audio narration
   - Toggle switch to change between modes

2. **Word Count Mode Settings**:
   - **Frequency Type**: Variable or Consistent
   - **Variable**: Different intervals for first page (15-60s) vs. rest (10-90s)
   - **Consistent**: Single interval (5-900s) throughout entire story
   - Real-time image count estimation
   - Example: 10,000 words at 30s/image ≈ 24 images

3. **Audio Runtime Mode Settings**:
   - **Audio Source Options**:
     - Generate audio: Estimate from word count
     - Existing audio: Select from previously generated audio files
     - Upload audio: Upload custom audio file(s) or folder
   - **Duration Calculation**:
     - Automatic calculation from audio files
     - Manual entry option
     - Loading states with progress indicators
   - **Distribution Types**:
     - **Consistent**: Evenly distribute N images across total duration
     - **Variable**: Specify image counts for first page and rest
   - **Audio File Management**:
     - Single file or folder upload support
     - TUS resumable upload for large files (up to 500MB)
     - Duration extraction from WAV/MP3 files
     - File list with duration display

4. **Integration with Video Generator**:
   - Automatically triggers duration calculation when switching to audio mode
   - Syncs with Step 2 (Audio Configuration) in video generation workflow
   - Validates audio file compatibility
   - Disables existing audio option for uploaded story documents

5. **Real-Time Feedback**:
   - Dynamic image count calculations
   - Upload progress indicators
   - Duration loading states
   - Error messages with context
   - Validation warnings

**Props Interface**:

```typescript
interface ImageFrequencyConfigurationProps {
  mode: "wordcount" | "audio";
  onModeChange: (mode: "wordcount" | "audio") => void;
  frequencyType: "consistent" | "variable";
  onFrequencyTypeChange: (type: "consistent" | "variable") => void;

  // Word count mode props
  wordCount: number;
  consistentFrequency: string;
  firstPageFrequency: string;
  restFrequency: string;

  // Audio mode props
  selectedStoryGroupId: string | null;
  audioFiles: AudioFile[];
  totalAudioDuration: number;
  imageAmount: string;
  audioDistributionType: "consistent" | "variable";
  audioFirstPageImageCount: string;
  audioRestImageCount: string;

  // Video Generator specific
  isVideoGenerator?: boolean;
  calculatedAudioDuration?: number;
  handleCalculateAudioDuration?: () => Promise<void>;
}
```

**Calculation Examples**:

```typescript
// Word Count Mode (Variable)
const firstPageImages = Math.ceil(3000 / (30 * 13.67)); // ≈ 7 images
const restImages = Math.ceil(7000 / (60 * 13.67)); // ≈ 9 images
const totalImages = firstPageImages + restImages; // 16 images

// Audio Runtime Mode (Consistent)
const audioDuration = 1800; // 30 minutes in seconds
const totalImages = 20;
const intervalSeconds = audioDuration / totalImages; // 90 seconds per image

// Audio Runtime Mode (Variable)
const firstPageDuration = 180; // 3 minutes
const restDuration = 1620; // 27 minutes
const firstPageImages = 5;
const restImages = 15;
const firstPageInterval = firstPageDuration / firstPageImages; // 36s per image
const restInterval = restDuration / restImages; // 108s per image
```

---

### Backend Functions

#### storyscriptai-setup-prompt.ts (Deno Deploy)

**Purpose**: Initial setup function that processes story documents and creates image prompt tasks.

**Location**: `denodeploy/storyscriptai-setup-prompt.ts`

**Endpoint**: `https://{deno-project}.deno.dev/storyscriptai-setup-prompt`

**Request Payload**:

```typescript
interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path: string; // Path to story document in storage
  story_title: string;
  description: string;
  style: string;
  useCharacterDescriptions: boolean;

  // Deprecated (V1) - Use frequencyMode fields instead
  firstPageFrequency: number | null; // NULL for consistent frequency mode
  restFrequency: number; // Seconds

  // V2: Frequency Mode Configuration (NEW)
  frequencyMode?: "wordcount" | "audio";
  frequencyType?: "consistent" | "variable";
  consistentFrequency?: number; // For consistent frequency type
  audioFiles?: Array<{
    path: string;
    name: string;
    duration: number;
    url?: string;
  }>;
  totalAudioDuration?: number; // Total audio duration in seconds
  imageAmount?: number; // Total images for consistent audio mode
  audioDistributionType?: "consistent" | "variable";
  audioFirstPageImageCount?: number; // For variable audio distribution
  audioRestImageCount?: number; // For variable audio distribution

  // V2: Master Prompt Support (NEW)
  masterPromptData?: {
    visualStyle: string;
    setting: string;
    atmosphere: string;
    environmentOnly: boolean;
    characters: Array<{ name: string; description: string }>;
  };
  environmentOnlyMode?: boolean; // Focus only on environment/atmosphere

  variant: number;
  doc_id: string;
  userTokenBalance: number;
  imageModel: string; // 'standard', 'plus', 'premium', 'spark', 'prime', 'genesis'
  language: string;
  model: string; // 'deepseek', 'sonnet', 'opus'
  processImage?: boolean;
  videoProcess?: boolean;
  tab?: number;
}
```

**Process Flow**:

1. **Download Story Document**:

   ```typescript
   const { data: fileData, error: downloadError } = await supabase.storage
     .from("story_documents")
     .download(file_path);

   const text = await fileData.text();
   const cleanedText = cleanCurlyQuotes(text);
   const wordCount = calculateWordCount(cleanedText);
   ```

2. **Create Image Prompt Context** (NEW - V2):

   ```typescript
   // Insert full story context into image_prompt_context table
   await supabase.from("image_prompt_context").insert({
     group_id,
     user_id,
     tab,
     full_story_text: cleanedText,
     word_count: wordCount,
     character_count: cleanedText.length,
     master_prompt_data: masterPromptData || null,
     environment_only_mode: environmentOnlyMode || false,
     style_description: style,
     character_descriptions: null, // Populated later if needed
     video_process: videoProcess || false,
     process_image: processImage || false,
   });
   ```

3. **Extract Character Descriptions** (if `useCharacterDescriptions=true` and not `environmentOnlyMode`):

   ```typescript
   async function extractCharacterDescriptions(text: string) {
     // Use Claude Sonnet 4 to identify characters
     const systemPrompt = `Extract character physical descriptions from this story.
     Return JSON: { "CharacterName": "description", ... }`;

     const response = await anthropic.messages.create({
       model: "claude-sonnet-4-6",
       max_tokens: 4096,
       messages: [{ role: "user", content: text }],
     });

     // Update image_prompt_context with character descriptions (NEW)
     await supabase
       .from("image_prompt_context")
       .update({
         character_descriptions: JSON.parse(response.content),
       })
       .eq("group_id", group_id);

     return {
       characters: JSON.parse(response.content),
       inputTokens: response.usage.input_tokens,
       outputTokens: response.usage.output_tokens,
     };
   }
   ```

4. **Segment Text by Mode**:

   **A. Word Count Mode** (Traditional):

   ```typescript
   const CHARS_PER_SECOND = 13.67;

   function segmentTextByWordCount(
     text: string,
     firstPageSeconds: number | null,
     restSeconds: number,
     frequencyType: "consistent" | "variable",
     consistentFrequency?: number,
   ): Segment[] {
     // Detect chapter boundaries
     const chapters = detectChapterSections(text);

     const actualFirstPageSeconds =
       frequencyType === "consistent"
         ? consistentFrequency
         : firstPageSeconds || 30;
     const actualRestSeconds =
       frequencyType === "consistent" ? consistentFrequency : restSeconds;

     let segments: Segment[] = [];
     let globalPosition = 0;

     for (const chapter of chapters) {
       const chapterSegments = segmentChapterSection(
         chapter.text,
         chapter.startPos,
         actualFirstPageSeconds,
         actualRestSeconds,
         globalPosition,
       );
       segments.push(...chapterSegments);
       globalPosition += chapter.text.length;
     }

     return segments;
   }
   ```

   **B. Audio Runtime Mode** (NEW):

   ```typescript
   function segmentTextByAudioDuration(
     text: string,
     totalAudioDuration: number,
     distributionType: "consistent" | "variable",
     imageAmount?: number,
     firstPageImageCount?: number,
     restImageCount?: number,
   ): Segment[] {
     const totalChars = text.length;

     if (distributionType === "consistent") {
       // Evenly distribute images across audio duration
       const secondsPerImage = totalAudioDuration / imageAmount;
       const charsPerImage = Math.floor(secondsPerImage * CHARS_PER_SECOND);

       return distributeSegmentsEvenly(text, charsPerImage);
     } else {
       // Variable: Different counts for first page vs rest
       const firstPageDuration = 180; // First 3 minutes
       const restDuration = totalAudioDuration - firstPageDuration;

       const firstPageCharsPerImage = Math.floor(
         (firstPageDuration / firstPageImageCount) * CHARS_PER_SECOND,
       );
       const restCharsPerImage = Math.floor(
         (restDuration / restImageCount) * CHARS_PER_SECOND,
       );

       return distributeSegmentsVariable(
         text,
         firstPageCharsPerImage,
         restCharsPerImage,
       );
     }
   }
   ```

5. **OLD: Segment Text by Reading Speed**:

   ```typescript
   const CHARS_PER_SECOND = 13.67;

   function segmentText(
     text: string,
     firstPageSeconds: number,
     restSeconds: number,
   ): Segment[] {
     // Detect chapter boundaries
     const chapters = detectChapterSections(text);

     let segments: Segment[] = [];
     let globalPosition = 0;

     for (const chapter of chapters) {
       const chapterSegments = segmentChapterSection(
         chapter.text,
         chapter.startPos,
         firstPageSeconds,
         restSeconds,
         globalPosition,
       );
       segments.push(...chapterSegments);
       globalPosition += chapter.text.length;
     }

     return segments;
   }

   function segmentChapterSection(
     sectionText: string,
     sectionStartPos: number,
     firstPageSeconds: number,
     restSeconds: number,
   ): Segment[] {
     const segments: Segment[] = [];
     const firstPageChars = Math.floor(firstPageSeconds * CHARS_PER_SECOND);
     const restChars = Math.floor(restSeconds * CHARS_PER_SECOND);

     // First page segment
     let pos = 0;
     let end = Math.min(firstPageChars, sectionText.length);

     // Break at sentence boundary
     while (end < sectionText.length && /[a-zA-Z0-9]/.test(sectionText[end])) {
       end++;
     }

     segments.push({
       text: sectionText.slice(pos, end),
       start: sectionStartPos + pos,
       is_first_page: true,
     });

     // Remaining segments
     pos = end;
     while (pos < sectionText.length) {
       end = Math.min(pos + restChars, sectionText.length);
       while (
         end < sectionText.length &&
         /[a-zA-Z0-9]/.test(sectionText[end])
       ) {
         end++;
       }

       segments.push({
         text: sectionText.slice(pos, end),
         start: sectionStartPos + pos,
         is_first_page: false,
       });

       pos = end;
     }

     return segments;
   }
   ```

6. **Determine Batch Count** (Based on Model):

   ```typescript
   function determineBatchCount(
     segments: Segment[],
     restFrequency: number,
     model: string,
   ): [number, number, number] {
     const totalSegments = segments.length;

     // DeepSeek can handle more segments per batch (20)
     // Claude models use smaller batches (10-15) due to token limits
     const maxSegmentsPerBatch = model === "deepseek" ? 20 : 15;

     const batchCount = Math.ceil(totalSegments / maxSegmentsPerBatch);
     const totalPrompts = totalSegments;

     return [batchCount, totalPrompts, totalSegments];
   }
   ```

7. **Assign Segments to Batches**:

   ```typescript
   function assignBatches(
     segments: Segment[],
     restFrequency: number,
     model: string,
   ): number[][] {
     const maxSegmentsPerBatch = model === "deepseek" ? 20 : 15;
     const batches: number[][] = [];
     let currentBatch: number[] = [];

     for (let i = 0; i < segments.length; i++) {
       currentBatch.push(i);

       if (
         currentBatch.length >= maxSegmentsPerBatch ||
         i === segments.length - 1
       ) {
         batches.push([...currentBatch]);
         currentBatch = [];
       }
     }

     return batches;
   }
   ```

8. **Create Tasks in Database**:

   ```typescript
   const batches = assignBatches(segments, restFrequency, model);

   for (let i = 0; i < batches.length; i++) {
     const batchSegmentIndices = batches[i];
     const batchSegments = batchSegmentIndices.map((idx) => segments[idx]);

     const task = {
       user_id,
       group_id,
       story_title,
       description,
       batch: batchSegments, // JSONB array
       batch_number: i + 1,
       total_batches: batches.length,
       total_prompts: segments.length,
       status: i === 0 ? "queued" : "pending", // First batch starts immediately
       progress: 0,
       settings: {
         style,
         useCharacterDescriptions,
         firstPageFrequency: firstPageFrequency.toString(),
         restFrequency: restFrequency.toString(),
         characters, // Extracted descriptions
       },
       variant,
       doc_id,
       file_path,
       image_model: getBackendImageModel(imageModel),
       video_process: videoProcess,
       language,
       model,
       process_image: processImage,
       tab,
     };

     await supabase.from("image_prompt_tasks").insert(task);
   }
   ```

9. **Trigger First Batch**:
   ```typescript
   // Call process-image-batch for batch 1
   await fetch(`${supabaseUrl}/functions/v1/process-image-batch`, {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${supabaseServiceKey}`,
     },
     body: JSON.stringify({
       group_id,
       user_id,
       batch_number: 1,
       tab,
     }),
   });
   ```

**Response**:

```json
{
  "message": "Image prompt tasks created successfully",
  "group_id": "uuid",
  "total_batches": 12,
  "total_prompts": 234,
  "character_extraction_tokens": {
    "input": 15000,
    "output": 500
  }
}
```

#### process-image-batch (Supabase Edge Function)

**Purpose**: Processes a single batch of image prompt tasks by calling the AI model.

**Location**: `supabase/functions/process-image-batch/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/process-image-batch`

**Request**:

```typescript
{
  group_id: string;
  user_id: string;
  batch_number: number;
  tab?: number;
}
```

**Process Flow**:

1. **Fetch Task from Database**:

   ```typescript
   const { data: tasks } = await supabase
     .from("image_prompt_tasks")
     .select("*")
     .eq("group_id", group_id)
     .eq("user_id", user_id)
     .eq("batch_number", batch_number)
     .eq("tab", tab || 1);

   const task = tasks[0];
   ```

2. **Check Stop Request**:

   ```typescript
   if (task.stop_requested) {
     await supabase
       .from("image_prompt_tasks")
       .update({ status: "stopped" })
       .eq("id", task.id);
     return { message: "Generation stopped by user" };
   }
   ```

3. **Update Status to Processing**:

   ```typescript
   await supabase
     .from("image_prompt_tasks")
     .update({ status: "processing", updated_at: new Date().toISOString() })
     .eq("id", task.id);
   ```

4. **Prepare Text Part for This Batch**:

   ```typescript
   // Segments are stored in task.batch as JSONB
   const segments = task.batch; // Array of { text, start, is_first_page }
   const textPart = segments.map((s) => s.text).join("\n\n");

   // Store text_part for reference
   await supabase
     .from("image_prompt_tasks")
     .update({ text_part: textPart })
     .eq("id", task.id);
   ```

5. **Call generate-image-prompts Function**:

   ```typescript
   const response = await fetch(
     `${supabaseUrl}/functions/v1/generate-image-prompts`,
     {
       method: "POST",
       headers: {
         "Content-Type": "application/json",
         Authorization: `Bearer ${supabaseServiceKey}`,
       },
       body: JSON.stringify({
         segments: task.batch,
         style: task.settings.style,
         characters: task.settings.characters || {},
         language: task.language,
         model: task.model,
       }),
     },
   );

   const result = await response.json();
   ```

6. **Store Results**:

   ```typescript
   await supabase
     .from("image_prompt_tasks")
     .update({
       batch_output: result.prompts, // Array of prompt strings
       input_tokens: result.input_tokens,
       output_tokens: result.output_tokens,
       status: "completed",
       progress: 100,
       updated_at: new Date().toISOString(),
     })
     .eq("id", task.id);
   ```

7. **Update User Token Balance**:

   ```typescript
   const tokenCost = result.input_tokens + result.output_tokens;
   await supabase.rpc("decrement_tokens", {
     user_id: task.user_id,
     amount: tokenCost,
   });

   await supabase
     .from("image_prompt_tasks")
     .update({ token_updated: true })
     .eq("id", task.id);
   ```

8. **Check if All Batches Complete**:

   ```typescript
   const { data: allTasks } = await supabase
     .from("image_prompt_tasks")
     .select("status")
     .eq("group_id", group_id)
     .eq("tab", tab);

   const completed = allTasks.filter(
     (t) => t.status === "completed" || t.status === "completed_final",
   ).length;

   if (completed === task.total_batches) {
     // Mark last task as completed_final
     await supabase
       .from("image_prompt_tasks")
       .update({ status: "completed_final" })
       .eq("id", task.id);

     // Compile final document
     await compileFinalDocument(
       user_id,
       group_id,
       task.story_title,
       task.description,
       task.variant,
       task.is_corrected,
       task.version,
       task.image_model,
       task.language,
       task.model,
       task.process_image,
       tab,
     );
   } else {
     // Trigger next batch
     await triggerNextBatch(
       group_id,
       user_id,
       batch_number,
       task.total_batches,
       tab,
     );
   }
   ```

9. **Error Handling**:
   ```typescript
   try {
     // ... processing
   } catch (error) {
     await supabase
       .from("image_prompt_tasks")
       .update({
         status: "error",
         error: error.message,
         updated_at: new Date().toISOString(),
       })
       .eq("id", task.id);
     throw error;
   }
   ```

**Compile Final Document**:

```typescript
async function compileFinalDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  version: number,
  imageModel: string,
  language: string,
  model: string,
  processImage: boolean,
  tab: number,
) {
  // 1. Fetch all completed batches
  const { data: tasks } = await supabase
    .from("image_prompt_tasks")
    .select("batch_output, batch_number")
    .eq("group_id", groupId)
    .eq("tab", tab)
    .order("batch_number", { ascending: true });

  // 2. Combine all prompts
  const allPrompts = tasks.flatMap((t) => JSON.parse(t.batch_output));

  // 3. Format as document
  const promptDocument = allPrompts
    .map((prompt, index) => `Image ${index + 1}:\n${prompt}\n`)
    .join("\n");

  // 4. Save to storage
  const fileName = `${title}_image_prompts_v${version}_var${variant}.txt`;
  const filePath = `image_prompts/${userId}/${groupId}/${fileName}`;

  await supabase.storage
    .from("story_documents")
    .upload(filePath, promptDocument, {
      contentType: "text/plain",
      upsert: true,
    });

  // 5. Create story_documents entry
  await supabase.from("story_documents").insert({
    user_id: userId,
    group_id: groupId,
    title: `${title} - Image Prompts`,
    description,
    file_path: filePath,
    word_count: promptDocument.split(/\s+/).length,
    is_corrected: isCorrected,
    is_prompted: true,
    version,
    variant,
    tab,
  });

  // 6. If processImage=true, trigger image generation
  if (processImage) {
    await triggerImageGeneration(
      userId,
      groupId,
      doc_id,
      title,
      description,
      variant,
      imageModel,
      language,
      tab,
    );
  }
}
```

#### generate-image-prompts (Supabase Edge Function)

**Purpose**: AI-powered function that generates detailed image prompts from story text segments.

**Location**: `supabase/functions/generate-image-prompts/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/generate-image-prompts`

**Request**:

```typescript
{
  segments: Array<{ text: string; start: number; is_first_page: boolean }>;
  style: string;
  characters: Record<string, string>; // { "John": "tall man, brown hair", ... }
  language: string; // Output language
  model: string; // 'deepseek', 'sonnet', 'opus'
}
```

**Model Configuration**:

```typescript
const MODEL_CONFIGS = {
  deepseek: {
    apiKey: deepseekApiKey,
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
    tokenMultiplier: 1.0,
  },
  sonnet: {
    apiKey: anthropicApiKey,
    baseURL: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    tokenMultiplier: 10.0,
  },
  opus: {
    apiKey: anthropicApiKey,
    baseURL: "https://api.anthropic.com",
    model: "claude-opus-4-6",
    tokenMultiplier: 48.0,
  },
};
```

**Process Flow**:

1. **Text Normalization**:

   ```typescript
   function normalizeText(text: string): string {
     // Fix corrupted UTF-8 characters (mojibake)
     let normalized = text
       .replace(/â€™/g, "'") // Curly apostrophe
       .replace(/â€œ/g, '"') // Opening quote
       .replace(/â€/g, '"') // Closing quote
       .replace(/â€"/g, "—") // Em dash
       .replace(/â€"/g, "–") // En dash
       .replace(/�/g, "'"); // Replacement character

     // Normalize Unicode
     normalized = normalized
       .replace(/[\u2018\u2019]/g, "'") // Curly quotes
       .replace(/[\u201C\u201D]/g, '"') // Smart quotes
       .replace(/\u2014/g, "—") // Em dash
       .replace(/\u2013/g, "–") // En dash
       .replace(/\u2026/g, "..."); // Ellipsis

     return normalized;
   }
   ```

2. **Build System Prompt**:

   ```typescript
   function getSystemPrompts(
     language: string,
     segmentLength: number,
     style: string,
     characters: Record<string, string>,
     model: string,
   ) {
     const characterContext =
       Object.keys(characters).length > 0
         ? `\n\nCharacter Descriptions:\n${Object.entries(characters)
             .map(([name, desc]) => `- ${name}: ${desc}`)
             .join("\n")}`
         : "";

     const systemPrompt = `You are an expert at creating detailed image generation prompts for story visualization.
   
   Your task:
   1. Analyze the provided story text segment
   2. Generate a detailed visual description that captures the scene, characters, mood, and setting
   3. Include character physical descriptions when mentioned (use provided character context)
   4. Apply the style: "${style}"
   5. Output in ${language}
   6. Return ONLY a JSON array of prompts, one per logical scene break
   
   Format: ["prompt1", "prompt2", ...]
   
   Guidelines:
   - Each prompt should be 2-3 sentences
   - Focus on visual details (what you would SEE in an image)
   - Include lighting, composition, mood
   - Maintain consistency with character descriptions
   - Use cinematic language
   - Break text into ${segmentLength > 1000 ? "multiple scenes" : "one scene"}
   
   ${characterContext}`;

     return systemPrompt;
   }
   ```

3. **Call AI Model**:

   ```typescript
   async function callModelAPI(
     config: any,
     messages: any[],
     options: any,
     model: string,
   ) {
     if (model === "deepseek") {
       // OpenAI-compatible API
       const response = await fetch(`${config.baseURL}/v1/chat/completions`, {
         method: "POST",
         headers: {
           "Content-Type": "application/json",
           Authorization: `Bearer ${config.apiKey}`,
         },
         body: JSON.stringify({
           model: config.model,
           messages,
           temperature: 0.7,
           max_tokens: 4096,
         }),
       });

       const result = await response.json();
       return {
         content: result.choices[0].message.content,
         input_tokens: result.usage.prompt_tokens,
         output_tokens: result.usage.completion_tokens,
       };
     } else {
       // Claude API
       const response = await fetch(`${config.baseURL}/v1/messages`, {
         method: "POST",
         headers: {
           "Content-Type": "application/json",
           "x-api-key": config.apiKey,
           "anthropic-version": "2023-06-01",
         },
         body: JSON.stringify({
           model: config.model,
           max_tokens: 4096,
           temperature: 0.7,
           system: messages[0].content, // System prompt
           messages: messages.slice(1), // User messages
         }),
       });

       const result = await response.json();
       return {
         content: result.content[0].text,
         input_tokens: result.usage.input_tokens,
         output_tokens: result.usage.output_tokens,
       };
     }
   }
   ```

4. **Process Each Segment**:

   ```typescript
   const allPrompts: PromptResult[] = [];
   let totalInputTokens = 0;
   let totalOutputTokens = 0;

   for (const segment of segments) {
     const normalizedText = normalizeText(segment.text);
     const systemPrompt = getSystemPrompts(
       language,
       normalizedText.length,
       style,
       characters,
       model,
     );

     const messages = [
       { role: "system", content: systemPrompt },
       {
         role: "user",
         content: `Generate image prompts for this story segment:\n\n${normalizedText}`,
       },
     ];

     const response = await callModelAPI(
       MODEL_CONFIGS[model],
       messages,
       {},
       model,
     );

     // Parse JSON response
     const prompts = cleanAndParseJSON(response.content);

     allPrompts.push(...prompts.map((p) => ({ prompt: p, segment })));
     totalInputTokens += response.input_tokens;
     totalOutputTokens += response.output_tokens;
   }
   ```

5. **Validate Word Preservation**:

   ```typescript
   // Ensure prompts don't lose important story words
   function validateWordPreservation(
     results: PromptResult[],
     originalSegments: Segment[],
   ): string | null {
     for (let i = 0; i < originalSegments.length; i++) {
       const originalWords = extractWords(originalSegments[i].text);
       const promptWords = extractWords(results[i]?.prompt || "");

       // Check if important words are preserved (character names, locations)
       const importantWords = originalWords.filter(
         (w) => w.length > 3 && /^[A-Z]/.test(w),
       );
       const preserved = importantWords.filter((w) =>
         promptWords.some((pw) => pw.toLowerCase() === w.toLowerCase()),
       );

       if (preserved.length < importantWords.length * 0.5) {
         return `Segment ${i + 1} lost too many important words`;
       }
     }
     return null;
   }

   const validationError = validateWordPreservation(allPrompts, segments);
   if (validationError) {
     throw new Error(validationError);
   }
   ```

6. **Return Results**:
   ```typescript
   return {
     prompts: allPrompts.map((p) => p.prompt),
     input_tokens: totalInputTokens,
     output_tokens: totalOutputTokens,
     model_used: model,
   };
   ```

**Response**:

```json
{
  "prompts": [
    "A tall man with brown hair stands in a dimly lit room, moonlight streaming through a window. Cinematic lighting, dramatic shadows, realistic style.",
    "A young woman with red hair walks through a forest at dawn, mist rolling through the trees. Soft golden light, ethereal atmosphere, photorealistic.",
    "..."
  ],
  "input_tokens": 5234,
  "output_tokens": 892,
  "model_used": "deepseek"
}
```

#### trigger-image-next-batch (Supabase Edge Function)

**Purpose**: Queues and triggers the next pending image prompt batch after a batch completes.

**Location**: `supabase/functions/trigger-image-next-batch/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/trigger-image-next-batch`

**Request**:

```typescript
{
  group_id: string;
  user_id: string;
  current_batch_number: number;
  tab?: number;
}
```

**Process Flow**:

1. **Fetch All Tasks for Group**:

   ```typescript
   const { data: tasks } = await supabase
     .from("image_prompt_tasks")
     .select("*")
     .eq("group_id", group_id)
     .eq("user_id", user_id)
     .eq("tab", tab || 1)
     .order("batch_number", { ascending: true });
   ```

2. **Check Completion**:

   ```typescript
   const totalBatches = tasks[0].total_batches;
   const completedCount = tasks.filter(
     (t) => t.status === "completed" || t.status === "completed_final",
   ).length;

   if (completedCount >= totalBatches) {
     return { message: "All batches completed", completed: true };
   }
   ```

3. **Find Next Task**:

   ```typescript
   // Prioritize queued tasks, then pending/error tasks
   const nextTask =
     tasks.find(
       (t) => t.status === "queued" && t.batch_number >= current_batch_number,
     ) ||
     tasks.find(
       (t) =>
         (t.status === "pending" || t.status === "error") &&
         t.batch_number >= current_batch_number,
     );

   if (!nextTask) {
     throw new Error("No pending tasks found");
   }
   ```

4. **Update Status to Queued**:

   ```typescript
   if (nextTask.status !== "queued") {
     await supabase
       .from("image_prompt_tasks")
       .update({ status: "queued", updated_at: new Date().toISOString() })
       .eq("id", nextTask.id);
   }
   ```

5. **Trigger process-image-batch**:
   ```typescript
   const response = await fetch(
     `${supabaseUrl}/functions/v1/process-image-batch`,
     {
       method: "POST",
       headers: {
         "Content-Type": "application/json",
         Authorization: `Bearer ${supabaseServiceKey}`,
       },
       body: JSON.stringify({
         group_id,
         user_id,
         batch_number: nextTask.batch_number,
         tab,
       }),
     },
   );
   ```

**Response**:

```json
{
  "message": "Batch 5 queued successfully",
  "batch_number": 5
}
```

---

### User Workflows

#### Basic Image Prompt Generation

1. **Navigate to Image Prompts Page**:
   - Click "Image Prompts" in navigation
   - Enterprise users see TabManager at top

2. **Select Document**:
   - **Option A**: Select existing story document from dropdown
     - Documents filtered by tab (enterprise users)
     - Shows title, word count, date, version, variant
   - **Option B**: Upload new .txt/.docx file
     - Drag-and-drop or click to browse
     - Max 70,000 words, 1MB file size
     - Word count extracted automatically

3. **Configure Settings**:
   - **Style**: Select from 800+ predefined styles or enter custom
   - **Character Descriptions**: Toggle to extract character details from story
   - **First Page Frequency**: 15-60 seconds (default 30s)
   - **Rest Page Frequency**: 10-30 seconds (default 20s)
   - **Image Model**: Standard/Plus/Premium/Spark/Prime/Genesis
   - **Language**: English/German/Spanish/French
   - **AI Model**: Core (DeepSeek 1x) / Sonnet (10x) / Opus (48x)

4. **Review Estimates**:
   - Estimated images: `ceil(wordCount / (frequency * 13.67))`
   - Estimated tokens: `imageCount * modelMultiplier`
   - Total cost displayed before generation

5. **Start Generation**:
   - Click "Generate Image Prompts"
   - System checks token balance
   - Creates tasks in database
   - Triggers first batch processing

6. **Monitor Progress**:
   - Progress bar shows percentage complete
   - Status: "Setting up tasks" → "Processing batch X/Y" → "Compiling prompts" → "Complete"
   - Real-time polling every 3 seconds
   - Estimated time remaining displayed

7. **Review Results**:
   - Prompt document created in story_documents
   - Download available immediately
   - Preview shows first 10 prompts
   - If `processImage=true`, image generation starts automatically

8. **Download or Use Prompts**:
   - Download as .txt file
   - Copy individual prompts
   - Use in Image Generator page
   - Share with team (enterprise)

#### Multi-Tab Image Prompt Generation (Enterprise)

1. **Create Multiple Tabs**:
   - Click "+" button in TabManager
   - Each tab has independent state and group_id
   - Token estimates shown per tab and total

2. **Configure Each Tab**:
   - Different documents per tab
   - Different styles, frequencies, models
   - Independent progress tracking

3. **Parallel Processing**:
   - All tabs process simultaneously
   - Backend handles concurrent batches
   - No interference between tabs

4. **Monitor All Tabs**:
   - Tab badges show status (Idle/Generating/Complete/Error)
   - Click tabs to switch between generations
   - Total token usage across all tabs

5. **Close Tabs When Complete**:
   - Tab 1 cannot be closed
   - Closing tab stops generation and clears session storage
   - Prompts remain in database (story_documents)

#### Integration with Image Generation

1. **Automatic Trigger** (if `processImage=true`):
   - After prompt compilation completes
   - Creates image_tasks for all prompts
   - Starts image generation automatically
   - See Image Generation section for details

2. **Manual Trigger**:
   - Go to Image Generator page
   - Select prompt document
   - Configure image settings
   - Start generation

---

### AI Model Comparison

| Model           | Cost Multiplier | Speed  | Quality   | Best For                        |
| --------------- | --------------- | ------ | --------- | ------------------------------- |
| Core (DeepSeek) | 1.0x            | Fast   | Good      | Testing, drafts, high volume    |
| Claude Sonnet   | 10.0x           | Medium | Excellent | Production, detailed prompts    |
| Claude Opus     | 48.0x           | Slower | Best      | Premium content, maximum detail |

**Token Estimation**:

```typescript
// Base calculation
const segmentCount = segments.length;
const avgWordsPerSegment = 150;
const tokensPerWord = 1.33;

const estimatedInputTokens = segmentCount * avgWordsPerSegment * tokensPerWord;
const estimatedOutputTokens = segmentCount * 100; // ~100 tokens per prompt

const totalTokens =
  (estimatedInputTokens + estimatedOutputTokens) * modelMultiplier;
```

---

### Error Handling & Recovery

#### Common Errors

1. **Insufficient Tokens**:

   ```typescript
   if (estimatedTokens > tokenBalance) {
     throw new Error(
       `Need ${formatNumber(estimatedTokens)} tokens, have ${formatNumber(tokenBalance)}`,
     );
   }
   ```

2. **Document Too Large**:

   ```typescript
   if (wordCount > 70000) {
     throw new Error("Document exceeds 70,000 word limit");
   }
   if (fileSize > 1024 * 1024) {
     throw new Error("File exceeds 1MB size limit");
   }
   ```

3. **Network Errors**:

   ```typescript
   async function withRetry(operation, operationName, maxRetries = 10) {
     for (let attempt = 1; attempt <= maxRetries; attempt++) {
       try {
         return await operation();
       } catch (error) {
         if (attempt === maxRetries) throw error;

         // Exponential backoff
         const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
         await new Promise((resolve) => setTimeout(resolve, delay));
       }
     }
   }
   ```

4. **Task Stalled**:

   ```typescript
   function isTaskStalled(task: ImagePromptTask): boolean {
     if (task.status !== "processing") return false;

     const lastUpdate = new Date(task.updated_at).getTime();
     const now = Date.now();
     const stallTimeout = 30000; // 30 seconds

     return now - lastUpdate > stallTimeout;
   }

   // Recovery
   if (isTaskStalled(task)) {
     await supabase
       .from("image_prompt_tasks")
       .update({ status: "error", error: "Task stalled" })
       .eq("id", task.id);

     // Retry batch
     await triggerNextBatch(group_id, user_id, batch_number);
   }
   ```

5. **AI Model Errors**:
   ```typescript
   // Rate limiting
   if (error.status === 429) {
     await delay(60000); // Wait 1 minute
     return retry();
   }
   // Server errors
   if (error.status >= 500) {
     return retry(); // Automatic retry
   }
   // Invalid response
   if (!response.prompts || !Array.isArray(response.prompts)) {
     throw new Error("Invalid AI response format");
   }
   ```

#### Cleanup on Error

```typescript
async function cleanupFailedGeneration(
  userId: string,
  groupId: string,
  tab: number,
) {
  // 1. Mark all tasks as error
  await supabase
    .from("image_prompt_tasks")
    .update({ status: "error", stop_requested: true })
    .eq("group_id", groupId)
    .eq("tab", tab);

  // 2. Clear session storage
  clearTabSessionStorage(tab);

  // 3. Partial token refund (for incomplete batches)
  const { data: tasks } = await supabase
    .from("image_prompt_tasks")
    .select("input_tokens, output_tokens, token_updated")
    .eq("group_id", groupId)
    .eq("tab", tab);

  const refundAmount = tasks
    .filter((t) => !t.token_updated)
    .reduce((sum, t) => sum + t.input_tokens + t.output_tokens, 0);

  if (refundAmount > 0) {
    await supabase.rpc("increment_tokens", {
      user_id: userId,
      amount: refundAmount,
    });
  }
}
```

#### User-Initiated Stop

```typescript
// User clicks stop button
await supabase
  .from("image_prompt_tasks")
  .update({ stop_requested: true })
  .eq("group_id", groupId);

// Backend checks before each batch
if (task.stop_requested) {
  await supabase
    .from("image_prompt_tasks")
    .update({ status: "stopped" })
    .eq("group_id", groupId);

  return { message: "Generation stopped by user" };
}
```

---

### Token Management

#### Quota Checking

```typescript
// Before generation
const { data: userPlan } = await supabase
  .from("user_plans")
  .select("tokens_used, plan_max, plan_name")
  .eq("user_id", userId)
  .single();

const remaining = userPlan.plan_max - userPlan.tokens_used;

if (estimatedTokens > remaining) {
  throw new Error(
    `Insufficient tokens. Need ${formatNumber(estimatedTokens)}, have ${formatNumber(remaining)}`,
  );
}
```

#### Token Tracking

```typescript
// After each batch completes
const tokenCost = inputTokens + outputTokens;

await supabase.rpc("decrement_tokens", {
  user_id: userId,
  amount: tokenCost,
});

await supabase
  .from("image_prompt_tasks")
  .update({ token_updated: true })
  .eq("id", taskId);
```

#### Token History

```sql
-- Track token usage
SELECT
  user_id,
  SUM(input_tokens + output_tokens) as total_tokens,
  AVG(input_tokens + output_tokens) as avg_per_batch,
  COUNT(*) as batches_processed,
  model
FROM image_prompt_tasks
WHERE status = 'completed'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY user_id, model
ORDER BY total_tokens DESC;
```

---

### Integration with Video Pipeline

When `video_process=true`, image prompts coordinate with video creation:

1. **Completion Check**:

   ```typescript
   const allComplete = await checkAllVideoComponentsComplete(userId, groupId);

   if (allComplete.story && allComplete.prompts && allComplete.images) {
     await triggerVideoCreation(userId, groupId);
   }
   ```

2. **Prompt Requirements for Video**:
   - Prompts compiled into single document
   - Image count matches audio segment count
   - Timing synchronized with audio duration
   - Stored in `video_files/{group_id}/prompts.txt`

3. **Metadata for Video**:
   ```json
   {
     "group_id": "uuid",
     "prompt_count": 234,
     "style": "cinematic, realistic",
     "image_model": "imagen-4-fast",
     "character_descriptions": { "...": "..." }
   }
   ```

---

### Monitoring & Debugging

#### Active Tasks

```sql
-- Check active prompt generation tasks
SELECT
  user_id,
  group_id,
  story_title,
  batch_number,
  total_batches,
  status,
  progress,
  model,
  tab,
  updated_at
FROM image_prompt_tasks
WHERE status IN ('processing', 'queued')
ORDER BY updated_at DESC;
```

#### Stalled Tasks

```sql
-- Find stalled tasks (no update in 5 minutes)
SELECT
  id,
  group_id,
  batch_number,
  status,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) as seconds_stalled
FROM image_prompt_tasks
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '5 minutes';

-- Reset stalled tasks
UPDATE image_prompt_tasks
SET status = 'error',
    error = 'Task stalled - timeout'
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '5 minutes';
```

#### Token Usage by Model

```sql
-- Compare token costs across models
SELECT
  model,
  COUNT(*) as task_count,
  SUM(input_tokens + output_tokens) as total_tokens,
  AVG(input_tokens + output_tokens) as avg_tokens_per_task,
  SUM(CASE WHEN model = 'deepseek' THEN input_tokens + output_tokens
           WHEN model = 'sonnet' THEN (input_tokens + output_tokens) * 10
           WHEN model = 'opus' THEN (input_tokens + output_tokens) * 48
      END) as weighted_cost
FROM image_prompt_tasks
WHERE status = 'completed'
GROUP BY model
ORDER BY weighted_cost DESC;
```

#### Generation Performance

```sql
-- Average generation time per batch
SELECT
  model,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))) as median_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM image_prompt_tasks
WHERE status = 'completed'
GROUP BY model;
```

#### Storage Usage

```sql
-- Check prompt document storage
SELECT
  user_id,
  COUNT(*) as prompt_documents,
  SUM(word_count) as total_words,
  SUM(file_size) / (1024*1024) as total_mb
FROM story_documents
WHERE is_prompted = true
GROUP BY user_id
ORDER BY total_mb DESC;
```

---

## Image Generation

### Architecture Overview

The Image Generation system transforms text prompts into high-quality images using multiple AI image generation models. It processes prompts in batches, supports multiple generation models with different quality/cost tradeoffs, and includes advanced features like prompt rewriting, image regeneration, and quality enhancement.

**Core Workflow**:

1. User selects a prompt document or uploads/creates new prompts
2. System creates image generation tasks in batches
3. Each task is processed through the selected AI model (Imagen, GPT, Flux, Seedream, Nano Banana)
4. Generated images are uploaded to Supabase Storage
5. Results are compiled into a downloadable document with image URLs
6. Optionally triggers automatic video creation after completion

**Key Technologies**:

- **Database**: PostgreSQL (Supabase) - `image_tasks` table
- **Backend**: Supabase Edge Functions (Deno runtime)
- **AI Models**: Imagen 4 Fast/Ultra, GPT Image 1 Mini, Flux 2 Dev, Seedream 4.5, Nano Banana Pro
- **Image Processing**: Sharp.js for cropping/resizing to 16:9 aspect ratio
- **Frontend**: React with TypeScript, tab-aware session storage
- **Storage**: Supabase Storage - `generated_images` bucket organized by user/group folders

---

### Database Schema

#### image_tasks Table (36 Columns)

```sql
CREATE TABLE image_tasks (
  -- Core Identifiers
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID,
  group_id UUID NOT NULL,
  doc_id UUID,

  -- Story Context
  story_title TEXT NOT NULL,
  description TEXT,
  file_path TEXT,

  -- Batch Management
  batch JSONB NOT NULL,              -- Array of prompt objects
  batch_number INTEGER NOT NULL,
  total_batches INTEGER NOT NULL,
  total_prompts INTEGER NOT NULL,
  folder_timestamp TEXT,             -- Timestamp for storage folder organization

  -- Processing State
  status VARCHAR NOT NULL,           -- 'pending', 'queued', 'processing', 'completed', 'completed_final', 'error', 'stopped'
  progress INTEGER DEFAULT 0,
  error TEXT,
  stop_requested BOOLEAN DEFAULT false,
  check_stuck BOOLEAN DEFAULT false,

  -- Prompt & Output
  text_part TEXT,                    -- Partial prompt text for this batch
  batch_output TEXT,                 -- Generated image URLs/paths for this batch

  -- Image Settings
  settings JSONB NOT NULL,           -- { style, model-specific settings }
  image_model VARCHAR,               -- 'imagen-4-fast', 'gpt-image-1-mini', 'imagen-4-ultra', 'flux-2-dev', 'seedream-4.5', 'nano-banana-pro'
  language TEXT DEFAULT 'english',   -- Language for prompt rewriting
  single_image BOOLEAN DEFAULT false, -- Single image generation mode

  -- Redo/Regeneration
  redo_status TEXT,                  -- 'pending', 'processing', 'completed', 'error'
  redo_started_at TIMESTAMPTZ,       -- Timestamp when regeneration started

  -- Token & Cost Tracking
  tokens INTEGER DEFAULT 0,          -- Token cost for this batch
  token_updated BOOLEAN DEFAULT false,

  -- Versioning
  version INTEGER NOT NULL,
  variant INTEGER,
  is_corrected BOOLEAN NOT NULL,

  -- Video Integration
  video_process BOOLEAN,             -- If true, triggers video creation after completion

  -- Multi-tab Support
  tab INTEGER NOT NULL DEFAULT 1,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Legacy Fields
  outline TEXT,
  feedback TEXT
);

-- Indexes for performance
CREATE INDEX idx_image_tasks_group_id ON image_tasks(group_id);
CREATE INDEX idx_image_tasks_user_id ON image_tasks(user_id);
CREATE INDEX idx_image_tasks_status ON image_tasks(status);
CREATE INDEX idx_image_tasks_tab ON image_tasks(tab);
CREATE INDEX idx_image_tasks_batch_number ON image_tasks(batch_number);
```

**Key Field Details**:

- `batch`: JSONB array of prompt objects: `[{ text: string, index: number }, ...]`
- `settings`: JSONB object with generation settings:
  ```json
  {
    "style": "cinematic, realistic",
    "enhance_prompt": true,
    "safety_filter": true
  }
  ```
- `status`: Lifecycle states
  - `'pending'`: Task created, waiting to be queued
  - `'queued'`: Task queued for processing
  - `'processing'`: Currently generating images
  - `'completed'`: Batch completed successfully
  - `'completed_final'`: Last batch completed, document compiled
  - `'error'`: Generation failed
  - `'stopped'`: User stopped generation
- `image_model`: Determines AI model and cost
  - `imagen-4-fast`: Fast, good quality (14k tokens)
  - `gpt-image-1-mini`: Medium speed, better quality (30k tokens) **[Recommended]**
  - `imagen-4-ultra`: Slow, highest quality (42k tokens)
  - `flux-2-dev`: Fast, cheapest (7k tokens)
  - `seedream-4.5`: High quality (35k tokens)
  - `nano-banana-pro`: Premium quality (100k tokens)
- `folder_timestamp`: Organizes images in storage: `generated_images/{user_id}/{group_id}/{timestamp}/image_001.png`
- `single_image`: If true, generates only one image (quick generation mode)
- `redo_status`: Tracks regeneration attempts when user wants to remake an image

---

### Frontend Components

#### ImageGeneratorContainer

**Purpose**: Wrapper component managing tab state and forcing remounts when switching between premium tabs (elite, ultimate, enterprise).

**Location**: `src/pages/ImageGeneratorContainer.tsx`

**Key Responsibilities**:

- Initialize enterprise user status
- Manage tab configurations with `groupId` per tab
- Force complete remount of `ImageGenerator` when tab changes (via `key` prop)
- Handle tab creation, switching, and cleanup
- Ensure Tab 1 exists in database on mount

**State Management**:

```typescript
interface TabConfig {
  groupId: string;
  tab: number;
}

const [currentTab, setCurrentTab] = useState<number>(1);
const [tabConfigs, setTabConfigs] = useState<Record<number, TabConfig>>({
  1: { groupId: "", tab: 1 },
});
```

**Key Features**:

```typescript
// Tab switching triggers complete remount
<ImageGenerator
  key={`image-gen-tab-${currentTab}`}  // Forces remount
  initialTab={currentTab}
  initialGroupId={tabConfigs[currentTab]?.groupId}
  isEnterpriseUser={isEnterpriseUser}
  onTabChange={handleTabChange}
  onTabCreate={handleTabCreate}
  onTabClose={handleTabClose}
/>

// Cleanup on tab close
const handleTabClose = async (tab: number, groupId: string) => {
  const imageGeneratorRef = imageGeneratorRefs.current[tab];
  if (imageGeneratorRef) {
    await imageGeneratorRef.cleanup(); // Stops tasks, clears storage
  }
  // Remove from configs, switch to another tab
};
```

#### ImageGenerator

**Purpose**: Main image generation UI with prompt selection, model configuration, and progress tracking.

**Location**: `src/pages/ImageGenerator.tsx`

**State Management** (Tab-Aware Session Storage):

```typescript
// All state uses tab-specific keys via custom hook
const [documents, setDocuments] = useTabSessionStorage<StoryDocument[]>(
  "documents",
  [],
  tab,
);
const [selectedMode, setSelectedMode] = useTabSessionStorage<
  "document" | "prompts" | "new"
>("selectedMode", "document", tab);
const [imageSettings, setImageSettings] = useTabSessionStorage<ImageSettings>(
  "imageSettings",
  defaultSettings,
  tab,
);
```

**Generation Modes**:

1. **From Existing Document**:
   - Select prompt document from `story_documents` (filter by `is_prompted=true`)
   - Auto-loads prompts from document
   - Displays prompt count and estimated tokens

2. **From Raw Prompts**:
   - Textarea for manual prompt entry
   - One prompt per line
   - Real-time prompt count display

3. **New Prompt Generation**:
   - Triggers image prompt generation flow
   - Select story document → Configure settings → Generate prompts → Generate images

**Image Model Selection**:

```typescript
interface ImageModelOption {
  value: string; // Backend model name
  label: string; // Display name
  tokens: number; // Token cost per image
  description: string; // Description
  recommended?: boolean; // Highlight recommended
  borderColor: string; // UI border color
  bgColor: string; // UI background color
  textColor: string; // UI text color
}

const IMAGE_MODEL_OPTIONS = [
  {
    value: "flux-2-dev",
    label: "Spark",
    tokens: 7000,
    description: "Cheapest option",
  },
  {
    value: "imagen-4-fast",
    label: "Lite",
    tokens: 14000,
    description: "Good quality",
  },
  {
    value: "gpt-image-1-mini",
    label: "Core",
    tokens: 30000,
    description: "Better quality",
    recommended: true, // Default choice
  },
  {
    value: "seedream-4.5",
    label: "Prime",
    tokens: 35000,
    description: "High quality",
  },
  {
    value: "imagen-4-ultra",
    label: "Heavy",
    tokens: 42000,
    description: "Highest quality",
  },
  {
    value: "nano-banana-pro",
    label: "Genesis",
    tokens: 100000,
    description: "Premium quality",
  },
];
```

**Key Features**:

1. **Prompt Enhancement Toggle**:
   - Uses DeepSeek to rewrite prompts for better quality
   - Adds cinematic language, proper structure
   - Removes text/letters instructions
   - Adapts to model-specific requirements

2. **Storage Limit Checking**:

   ```typescript
   // Before generation
   const estimatedStorageMB = promptCount * IMAGE_SIZE_MB; // 1MB per image
   const currentUsageGB = await calculateStorageUsed(userId);

   if (currentUsageGB + estimatedStorageMB / 1024 > MAX_STORAGE_GB) {
     throw new Error(
       `Insufficient storage. Need ${estimatedStorageMB}MB, have ${MAX_STORAGE_GB * 1024 - currentUsageGB * 1024}MB remaining`,
     );
   }
   ```

3. **Token Estimation**:

   ```typescript
   const totalTokens = promptCount * modelTokenCost;
   const tokenBalance = userPlan.plan_max - userPlan.tokens_used;

   if (totalTokens > tokenBalance) {
     throw new Error(
       `Insufficient tokens. Need ${totalTokens}, have ${tokenBalance}`,
     );
   }
   ```

4. **Progress Tracking**:

   ```typescript
   const [progress, setProgress] = useState({
     current: 0,
     total: 0,
     percentage: 0,
     statusMessage: "",
     estimatedTimeRemaining: "",
   });

   // Real-time polling every 5 seconds
   useEffect(() => {
     if (generationState === "generating") {
       const interval = setInterval(pollProgress, 5000);
       return () => clearInterval(interval);
     }
   }, [generationState]);
   ```

5. **Image Preview & Download**:
   - Grid view of generated images
   - Individual image download
   - Bulk download as ZIP
   - Regenerate individual images
   - View full-size in modal

6. **Image Regeneration** (Redo):

   ```typescript
   // User clicks "Regenerate" on specific image
   const handleRedoImage = async (taskId: string, prompt: string) => {
     await supabase
       .from("image_tasks")
       .update({
         redo_status: "pending",
         redo_started_at: new Date().toISOString(),
       })
       .eq("id", taskId);

     // Call redo-image function
     await fetch(`${supabaseUrl}/functions/v1/redo-image`, {
       method: "POST",
       body: JSON.stringify({ task_id: taskId }),
     });
   };
   ```

7. **Error Handling**:
   - Network connectivity checks
   - Retry logic with exponential backoff
   - Stall detection (30s without progress)
   - User-friendly error messages
   - Cleanup on errors (removes incomplete tasks)

8. **Multi-Tab Support**:
   - Each tab has independent state
   - Separate progress tracking
   - No interference between tabs
   - Cleanup when tab closed

#### TabManager

**Purpose**: Premium feature for managing multiple image generation tabs simultaneously (elite, ultimate, and enterprise users).

**Location**: `src/components/TabManager.tsx`

**Features** (Same as Story/Audio/Prompts with `page='image'`):

- Display active tabs with status indicators
- Create new tabs (up to plan limit)
- Close tabs (Tab 1 cannot be closed)
- Token estimation per tab
- Total token count across all tabs
- Status badges: Idle (gray), Outline (yellow), Generating (blue), Complete (green), Error (red)

---

### Backend Functions

#### setup-image-tasks (Supabase Edge Function)

**Purpose**: Creates image generation tasks from a prompt document or prompt array.

**Location**: `supabase/functions/setup-image-tasks/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/setup-image-tasks`

**Request Payload**:

```typescript
interface SetupRequest {
  user_id: string;
  group_id: string;
  file_path?: string; // Path to prompt document in storage
  prompts?: string[]; // Or array of prompt strings
  story_title: string;
  description: string;
  doc_id: string;
  variant: number;
  image_model: string; // 'imagen-4-fast', 'gpt-image-1-mini', etc.
  videoProcess?: boolean;
  language?: string;
  tab?: number;
}
```

**Process Flow**:

1. **Download Prompt Document** (if file_path provided):

   ```typescript
   const { data: fileData, error: downloadError } = await supabase.storage
     .from("story_documents")
     .download(file_path);

   const content = await fileData.text();
   ```

2. **Extract Prompts from Document**:

   ```typescript
   function extractImagePrompts(content: string): Prompt[] {
     const prompts: Prompt[] = [];
     const startMarker = "[Image Prompt:";
     const endMarker = "]";
     let index = 1;

     let pos = 0;
     while (true) {
       const start = content.indexOf(startMarker, pos);
       if (start === -1) break;

       const end = content.indexOf(endMarker, start + startMarker.length);
       if (end === -1) break;

       const text = content.slice(start + startMarker.length, end).trim();
       if (text.length > 0) {
         prompts.push({ text, index });
         index++;
       }

       pos = end + endMarker.length;
     }

     return prompts;
   }
   ```

3. **Create Folder Timestamp**:

   ```typescript
   const folderTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
   // Example: "2026-02-04T10-30-45-123Z"
   ```

4. **Batch Prompts** (20 per batch):

   ```typescript
   const BATCH_SIZE = 20;
   const batches: Prompt[][] = [];

   for (let i = 0; i < prompts.length; i += BATCH_SIZE) {
     batches.push(prompts.slice(i, i + BATCH_SIZE));
   }
   ```

5. **Create Tasks in Database**:

   ```typescript
   const tasks = batches.map((batch, batchIndex) => ({
     user_id,
     group_id,
     story_title,
     description,
     batch, // JSONB array of prompts
     batch_number: batchIndex + 1,
     total_batches: batches.length,
     total_prompts: prompts.length,
     status: batchIndex === 0 ? "queued" : "pending",
     progress: 0,
     settings: {
       style: "cinematic, realistic",
       enhance_prompt: true,
     },
     variant,
     doc_id,
     file_path,
     folder_timestamp,
     image_model,
     video_process: videoProcess,
     language,
     version: 1,
     is_corrected: false,
     tokens: 0,
     tab,
   }));

   // Insert in batches of 20 to avoid timeout
   await insertTasksInBatches(tasks, startTime, maxRuntime);
   ```

6. **Trigger First Batch**:

   ```typescript
   // Call process-image for batch 1
   await fetch(`${supabaseUrl}/functions/v1/process-image`, {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       Authorization: `Bearer ${supabaseServiceKey}`,
     },
     body: JSON.stringify({
       group_id,
       user_id,
       batch_number: 1,
       tab,
     }),
   });
   ```

**Response**:

```json
{
  "message": "Image tasks created successfully",
  "group_id": "uuid",
  "total_batches": 12,
  "total_prompts": 234,
  "folder_timestamp": "2026-02-04T10-30-45-123Z"
}
```

#### process-image (Supabase Edge Function)

**Purpose**: Processes a single batch of image generation tasks by calling AI models.

**Location**: `supabase/functions/process-image/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/process-image`

**Request**:

```typescript
{
  group_id: string;
  user_id: string;
  batch_number: number;
  tab?: number;
}
```

**Process Flow**:

1. **Fetch Tasks for Batch**:

   ```typescript
   const { data: tasks } = await supabase
     .from("image_tasks")
     .select("*")
     .eq("group_id", group_id)
     .eq("user_id", user_id)
     .eq("batch_number", batch_number)
     .eq("tab", tab || 1);

   const task = tasks[0];
   ```

2. **Check Stop Request**:

   ```typescript
   if (task.stop_requested) {
     await supabase
       .from("image_tasks")
       .update({ status: "stopped" })
       .eq("id", task.id);
     return { message: "Generation stopped by user" };
   }
   ```

3. **Update Status to Processing**:

   ```typescript
   await supabase
     .from("image_tasks")
     .update({
       status: "processing",
       updated_at: new Date().toISOString(),
     })
     .eq("id", task.id);
   ```

4. **Process Each Prompt in Batch**:

   ```typescript
   const batch = task.batch; // Array of { text: string, index: number }
   const imageUrls: string[] = [];
   let totalTokens = 0;

   for (const promptObj of batch) {
     // Call generate-image function
     const response = await callGenerateImage({
       prompt: promptObj.text,
       image_number: promptObj.index,
       image_model: task.image_model,
       task_id: task.id,
     });

     if (response.status === "completed") {
       imageUrls.push(response.image_url);
       totalTokens += response.tokens;

       // Update progress
       const progress = Math.round((imageUrls.length / batch.length) * 100);
       await supabase
         .from("image_tasks")
         .update({ progress })
         .eq("id", task.id);
     }
   }
   ```

5. **Store Results**:

   ```typescript
   await supabase
     .from("image_tasks")
     .update({
       batch_output: JSON.stringify(imageUrls),
       tokens: totalTokens,
       status: "completed",
       progress: 100,
       updated_at: new Date().toISOString(),
     })
     .eq("id", task.id);
   ```

6. **Update User Token Balance**:

   ```typescript
   await supabase.rpc("decrement_tokens", {
     user_id: task.user_id,
     amount: totalTokens,
   });

   await supabase
     .from("image_tasks")
     .update({ token_updated: true })
     .eq("id", task.id);
   ```

7. **Check if All Batches Complete**:

   ```typescript
   const { data: allTasks } = await supabase
     .from("image_tasks")
     .select("status")
     .eq("group_id", group_id)
     .eq("tab", tab);

   const completed = allTasks.filter(
     (t) => t.status === "completed" || t.status === "completed_final",
   ).length;

   if (completed === task.total_batches) {
     // Mark last task as completed_final
     await supabase
       .from("image_tasks")
       .update({ status: "completed_final" })
       .eq("id", task.id);

     // Compile final document
     await compileFinalDocument(
       user_id,
       group_id,
       task.story_title,
       task.description,
       task.variant,
       task.is_corrected,
       task.version,
       task.folder_timestamp,
       tab,
     );

     // If video_process=true, check if all components ready
     if (task.video_process) {
       const allComplete = await checkAllStatusesCompleted(user_id, group_id);
       if (allComplete) {
         await triggerVideoCreation(user_id, group_id);
       }
     }
   } else {
     // Trigger next batch
     await triggerNextBatch(
       group_id,
       user_id,
       batch_number,
       task.total_batches,
       tab,
     );
   }
   ```

**Compile Final Document**:

```typescript
async function compileFinalDocument(
  userId: string,
  groupId: string,
  title: string,
  description: string,
  variant: number,
  isCorrected: boolean,
  version: number,
  folderTimestamp: string,
  tab: number,
) {
  // 1. Fetch all completed batches
  const { data: tasks } = await supabase
    .from("image_tasks")
    .select("batch_output, batch_number")
    .eq("group_id", groupId)
    .eq("tab", tab)
    .order("batch_number", { ascending: true });

  // 2. Combine all image URLs
  const allImageUrls = tasks.flatMap((t) => JSON.parse(t.batch_output));

  // 3. Format as document
  const imageDocument = allImageUrls
    .map((url, index) => `Image ${index + 1}:\n${url}\n`)
    .join("\n");

  // 4. Save to storage
  const fileName = `${title}_images_v${version}_var${variant}.txt`;
  const filePath = `generated_images/${userId}/${groupId}/${fileName}`;

  await supabase.storage
    .from("story_documents")
    .upload(filePath, imageDocument, {
      contentType: "text/plain",
      upsert: true,
    });

  // 5. Create story_documents entry
  const { data: doc } = await supabase
    .from("story_documents")
    .insert({
      user_id: userId,
      group_id: groupId,
      title: `${title} - Generated Images`,
      description,
      file_path: filePath,
      word_count: imageDocument.split(/\s+/).length,
      is_corrected: isCorrected,
      version,
      variant,
      tab,
    })
    .select()
    .single();

  // 6. Calculate and update file size
  await triggerSizeCalculation(doc.id, filePath, version);

  // 7. Delete task rows (cleanup)
  await deleteTaskRows(userId, groupId, tab);
}
```

#### generate-image (Supabase Edge Function)

**Purpose**: Calls AI image generation APIs to create images from prompts.

**Location**: `supabase/functions/generate-image/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/generate-image`

**Request**:

```typescript
{
  prompt: string;
  image_number: number;
  image_model: string;
  task_id?: string;
}
```

**Supported Models**:

1. **Imagen 4 Fast** (ModelLab):

```typescript
async function generateImagenFastImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const data = {
    key: modelLabApiKey,
    prompt: modifiedPrompt,
    model_id: "imagen-4.0-fast-generate",
    aspect_ratio: "16:9",
    width: "1024",
    height: "576",
  };

  const response = await fetch(
    "https://modelslab.com/api/v6/image_editing/imagen_v4",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );

  const result = await response.json();

  // Poll for completion
  while (result.status === "processing") {
    await delay(10000); // Wait 10 seconds
    const statusResponse = await fetch(result.fetch_url);
    result = await statusResponse.json();
  }

  return {
    image_url: result.output[0],
    tokens: 14000,
  };
}
```

2. **GPT Image 1 Mini** (OpenAI):

```typescript
async function generateGptImageMiniImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number; imageData: ArrayBuffer }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-image-1-mini",
      prompt: modifiedPrompt,
      n: 1,
      size: "1024x1024",
      quality: "standard",
    }),
  });

  const result = await response.json();
  const imageUrl = result.data[0].url;

  // Download and crop to 16:9
  const imageResponse = await fetch(imageUrl);
  const imageData = await imageResponse.arrayBuffer();
  const croppedData = await cropTo16x9(imageData);

  // Upload cropped image
  const fileName = `image_${Date.now()}.png`;
  const { data: uploadData } = await supabase.storage
    .from("generated_images")
    .upload(fileName, croppedData, { contentType: "image/png" });

  const { data: urlData } = supabase.storage
    .from("generated_images")
    .getPublicUrl(fileName);

  return {
    image_url: urlData.publicUrl,
    tokens: 30000,
    imageData: croppedData,
  };
}
```

3. **Imagen 4 Ultra** (ModelLab):

```typescript
async function generateImagenUltraImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const data = {
    key: modelLabApiKey,
    prompt: modifiedPrompt,
    model_id: "imagen-4.0-ultra-generate",
    aspect_ratio: "16:9",
    width: "1024",
    height: "576",
  };

  // Similar polling logic as Imagen Fast
  // ...

  return {
    image_url: result.output[0],
    tokens: 42000,
  };
}
```

4. **Flux 2 Dev** (FAL.ai):

```typescript
async function generateFluxDevImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const response = await fetch("https://fal.run/fal-ai/flux-2-dev", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${falApiKey}`,
    },
    body: JSON.stringify({
      prompt: modifiedPrompt,
      image_size: "landscape_16_9",
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true,
    }),
  });

  const result = await response.json();

  return {
    image_url: result.images[0].url,
    tokens: 7000,
  };
}
```

5. **Seedream 4.5** (FAL.ai):

```typescript
async function generateSeedreamImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number }> {
  // Apply safety filter for Seedream
  const filteredPrompt = applySeedreamSafetyFilter(prompt);

  const response = await fetch("https://fal.run/fal-ai/seedream-4.5", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${falApiKey}`,
    },
    body: JSON.stringify({
      prompt: filteredPrompt,
      image_size: "landscape_16_9",
      num_inference_steps: 50,
      guidance_scale: 7.5,
    }),
  });

  const result = await response.json();

  return {
    image_url: result.images[0].url,
    tokens: 35000,
  };
}
```

6. **Nano Banana Pro** (FAL.ai):

```typescript
async function generateNanaBananaImage(
  prompt: string,
): Promise<{ image_url: string; tokens: number }> {
  const modifiedPrompt = prompt + " NO White Background. NO TEXT or Letters.";

  const response = await fetch("https://fal.run/fal-ai/nano-banana-pro", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${falApiKey}`,
    },
    body: JSON.stringify({
      prompt: modifiedPrompt,
      image_size: "landscape_16_9",
      num_inference_steps: 75,
      guidance_scale: 10.0,
    }),
  });

  const result = await response.json();

  return {
    image_url: result.images[0].url,
    tokens: 100000,
  };
}
```

**Image Processing**:

```typescript
async function cropTo16x9(imageData: ArrayBuffer): Promise<ArrayBuffer> {
  const image = sharp(Buffer.from(imageData));
  const metadata = await image.metadata();

  const targetWidth = metadata.width!;
  const targetHeight = Math.round(targetWidth / (16 / 9));

  const croppedImage = await image
    .resize(targetWidth, targetHeight, {
      fit: "cover",
      position: "center",
    })
    .png()
    .toBuffer();

  return croppedImage.buffer;
}
```

**Response**:

```json
{
  "image_url": "https://storage.supabase.co/generated_images/...",
  "tokens": 30000,
  "status": "completed"
}
```

#### empty-redo (Supabase Edge Function)

**Purpose**: Regenerates an image with enhanced prompt rewriting using DeepSeek.

**Location**: `supabase/functions/empty-redo/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/empty-redo`

**Request**:

```typescript
{
  prompt: string;
  image_number: number;
  task_id: string;
  image_model: string;
}
```

**Process Flow**:

1. **Rewrite Prompt with DeepSeek**:

```typescript
async function rewritePromptWithDeepSeek(
  prompt: string,
  language: string = "english",
  imageModel: string = "",
): Promise<string> {
  const systemPrompt = getSystemPrompt(language, imageModel);

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 500,
    }),
  });

  const result = await response.json();
  return result.choices[0].message.content;
}

function getSystemPrompt(language: string, imageModel: string): string {
  return `You are an expert at rewriting image generation prompts for ${imageModel} model.

Task:
1. Rewrite the prompt to maximize image quality
2. Add cinematic language and proper structure
3. Include lighting, composition, mood details
4. Add "NO White Background. NO TEXT or Letters." at the end
5. Output in ${language}
6. Keep under 400 words

Format: Return only the rewritten prompt, nothing else.`;
}
```

2. **Generate Image with Enhanced Prompt**:

```typescript
// Call appropriate model function
const result = await generateImageWithModel(rewrittenPrompt, image_model);
```

3. **Update Task with New Image**:

```typescript
await supabase
  .from("image_tasks")
  .update({
    batch_output: result.image_url,
    tokens: result.tokens,
    redo_status: "completed",
  })
  .eq("id", task_id);
```

**Response**:

```json
{
  "image_url": "https://storage.supabase.co/generated_images/...",
  "tokens": 30000,
  "rewritten_prompt": "A cinematic wide-angle shot of a tall man with brown hair...",
  "status": "completed"
}
```

#### redo-image (Supabase Edge Function)

**Purpose**: User-initiated regeneration of a specific image without prompt rewriting.

**Location**: `supabase/functions/redo-image/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/redo-image`

**Request**:

```typescript
{
  task_id: string;
}
```

**Process Flow**:

1. **Fetch Original Task**:

```typescript
const { data: task } = await supabase
  .from("image_tasks")
  .select("*")
  .eq("id", task_id)
  .single();
```

2. **Extract Original Prompt**:

```typescript
const batch = task.batch;
const promptObj = batch[0]; // For single image redo
const originalPrompt = promptObj.text;
```

3. **Regenerate Image**:

```typescript
const result = await callGenerateImage({
  prompt: originalPrompt,
  image_number: promptObj.index,
  image_model: task.image_model,
  task_id: task.id,
});
```

4. **Update Task**:

```typescript
await supabase
  .from("image_tasks")
  .update({
    batch_output: result.image_url,
    tokens: result.tokens,
    redo_status: "completed",
  })
  .eq("id", task_id);
```

#### single-image (Supabase Edge Function)

**Purpose**: Generates a single image without batch processing (quick generation).

**Location**: `supabase/functions/single-image/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/single-image`

**Request**:

```typescript
{
  prompt: string;
  image_model: string;
  user_id: string;
  enhance_prompt?: boolean;
}
```

**Process Flow**:

1. **Check Token Balance**:

```typescript
const modelTokens = getTokensForModel(image_model);
const { data: userPlan } = await supabase
  .from("user_plans")
  .select("tokens_used, plan_max")
  .eq("user_id", user_id)
  .single();

if (userPlan.tokens_used + modelTokens > userPlan.plan_max) {
  throw new Error("Insufficient tokens");
}
```

2. **Enhance Prompt** (if enabled):

```typescript
if (enhance_prompt) {
  prompt = await rewritePromptWithDeepSeek(prompt);
}
```

3. **Generate Image**:

```typescript
const result = await generateImageWithModel(prompt, image_model);
```

4. **Update Tokens**:

```typescript
await supabase.rpc("decrement_tokens", {
  user_id,
  amount: result.tokens,
});
```

5. **Return Image URL**:

```typescript
return {
  image_url: result.image_url,
  tokens: result.tokens,
};
```

#### trigger-next-image (Supabase Edge Function)

**Purpose**: Queues and triggers the next pending image batch after a batch completes.

**Location**: `supabase/functions/trigger-next-image/index.ts`

**Endpoint**: `{supabase-url}/functions/v1/trigger-next-image`

**Request**:

```typescript
{
  group_id: string;
  user_id: string;
  current_batch_number: number;
  tab?: number;
}
```

**Process Flow**:

1. **Fetch All Tasks**:

```typescript
const { data: tasks } = await supabase
  .from("image_tasks")
  .select("*")
  .eq("group_id", group_id)
  .eq("user_id", user_id)
  .eq("tab", tab || 1)
  .order("batch_number", { ascending: true });
```

2. **Check Completion**:

```typescript
const totalBatches = tasks[0].total_batches;
const completedCount = tasks.filter(
  (t) => t.status === "completed" || t.status === "completed_final",
).length;

if (completedCount >= totalBatches) {
  return { message: "All batches completed", completed: true };
}
```

3. **Find Next Task**:

```typescript
const nextTask =
  tasks.find(
    (t) => t.status === "queued" && t.batch_number >= current_batch_number,
  ) ||
  tasks.find(
    (t) =>
      (t.status === "pending" || t.status === "error") &&
      t.batch_number >= current_batch_number,
  );
```

4. **Update to Queued**:

```typescript
if (nextTask.status !== "queued") {
  await supabase
    .from("image_tasks")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", nextTask.id);
}
```

5. **Trigger process-image**:

```typescript
await fetch(`${supabaseUrl}/functions/v1/process-image`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${supabaseServiceKey}`,
  },
  body: JSON.stringify({
    group_id,
    user_id,
    batch_number: nextTask.batch_number,
    tab,
  }),
});
```

---

### User Workflows

#### Basic Image Generation from Document

1. **Navigate to Image Generator Page**:
   - Click "Image Generator" in navigation
   - Enterprise users see TabManager at top

2. **Select Generation Mode**:
   - **Option A**: From Existing Document
     - Select prompt document from dropdown
     - Filter: `is_prompted=true`
     - Shows prompt count automatically
   - **Option B**: From Raw Prompts
     - Click "Use Raw Prompts" tab
     - Paste prompts (one per line)
     - Shows prompt count in real-time
   - **Option C**: Generate New Prompts
     - Click "Generate New Prompts" button
     - Redirects to Image Prompts page
     - Returns to Image Generator after prompt generation

3. **Select Image Model**:
   - 6 options with different quality/cost tradeoffs
   - **Spark** (Flux 2 Dev): 7k tokens, cheapest
   - **Lite** (Imagen 4 Fast): 14k tokens, good quality
   - **Core** (GPT Image 1 Mini): 30k tokens, recommended
   - **Prime** (Seedream 4.5): 35k tokens, high quality
   - **Heavy** (Imagen 4 Ultra): 42k tokens, highest quality
   - **Genesis** (Nano Banana Pro): 100k tokens, premium

4. **Enable Prompt Enhancement** (Optional):
   - Toggle "Enhance Prompts with AI"
   - Uses DeepSeek to rewrite prompts
   - Adds cinematic language, structure
   - Improves image quality

5. **Review Estimates**:
   - **Tokens**: `promptCount * modelTokenCost`
   - **Storage**: `promptCount * 1MB`
   - **Time**: `promptCount * timePerImage` (varies by model)
   - Check against token balance and storage limit

6. **Start Generation**:
   - Click "Generate Images"
   - System checks token balance and storage
   - Creates tasks in database
   - Triggers first batch processing

7. **Monitor Progress**:
   - Progress bar shows percentage complete
   - Status: "Setting up tasks" → "Generating batch X/Y" → "Compiling images" → "Complete"
   - Real-time polling every 5 seconds
   - Estimated time remaining displayed
   - Individual image previews appear as generated

8. **Review & Download Results**:
   - Grid view of all generated images
   - Click image for full-size preview
   - Download individual images
   - Download all as ZIP
   - Regenerate specific images if unsatisfied

#### Image Regeneration (Redo)

1. **From Generated Images Grid**:
   - Click "Regenerate" button on any image
   - Choose enhancement option:
     - **Standard Redo**: Uses original prompt
     - **Enhanced Redo**: Rewrites prompt with DeepSeek

2. **Monitor Regeneration**:
   - Image shows "Regenerating..." overlay
   - Progress updates in real-time
   - New image replaces old one when complete

3. **Compare Results**:
   - View old vs. new side-by-side
   - Keep or discard new version
   - Regeneration uses additional tokens

#### Multi-Tab Image Generation (Enterprise)

1. **Create Multiple Tabs**:
   - Click "+" button in TabManager
   - Each tab has independent state
   - Different documents/prompts per tab

2. **Configure Each Tab**:
   - Different models per tab
   - Different enhancement settings
   - Independent progress tracking

3. **Parallel Processing**:
   - All tabs process simultaneously
   - Backend handles concurrent batches
   - No interference between tabs

4. **Monitor All Tabs**:
   - Tab badges show status
   - Click tabs to switch between generations
   - Total token usage across all tabs

5. **Close Tabs When Complete**:
   - Tab 1 cannot be closed
   - Closing tab stops generation and clears session storage
   - Images remain in database (story_documents)

#### Single Image Quick Generation

1. **Navigate to Single Image Mode**:
   - Toggle "Single Image Mode"
   - Simplified interface

2. **Enter Prompt**:
   - Single text input
   - Optional enhancement toggle

3. **Select Model & Generate**:
   - Choose quality level
   - Instant generation (no batching)
   - Image displays immediately

---

### Image Model Comparison

| Model                 | Provider | Speed    | Quality | Cost (tokens) | Best For                     |
| --------------------- | -------- | -------- | ------- | ------------- | ---------------------------- |
| Spark (Flux 2 Dev)    | FAL.ai   | Fast     | Good    | 7,000         | Testing, drafts, high volume |
| Lite (Imagen Fast)    | ModelLab | Fast     | Good    | 14,000        | Quick results, prototypes    |
| Core (GPT Mini)       | OpenAI   | Medium   | Better  | 30,000        | **Recommended default**      |
| Prime (Seedream)      | FAL.ai   | Medium   | High    | 35,000        | Professional projects        |
| Heavy (Imagen Ultra)  | ModelLab | Slow     | Highest | 42,000        | Maximum quality              |
| Genesis (Nano Banana) | FAL.ai   | Variable | Premium | 100,000       | Premium content              |

**Time Per Image** (approximate):

- Spark: 10-15 seconds
- Lite: 15-20 seconds
- Core: 20-30 seconds
- Prime: 30-45 seconds
- Heavy: 45-60 seconds
- Genesis: 60-90 seconds

**Aspect Ratio**: All models generate 16:9 landscape images (1024x576 or cropped from 1024x1024)

---

### Error Handling & Recovery

#### Common Errors

1. **Insufficient Tokens**:

```typescript
if (totalTokens > tokenBalance) {
  throw new Error(
    `Need ${formatNumber(totalTokens)} tokens, have ${formatNumber(tokenBalance)}`,
  );
}
```

2. **Insufficient Storage**:

```typescript
const MAX_STORAGE_GB = 15;
const estimatedStorageMB = promptCount * IMAGE_SIZE_MB;

if (currentStorageGB + estimatedStorageMB / 1024 > MAX_STORAGE_GB) {
  throw new Error(
    `Insufficient storage. Need ${estimatedStorageMB}MB, have ${MAX_STORAGE_GB * 1024 - currentStorageGB * 1024}MB`,
  );
}
```

3. **Network Errors**:

```typescript
async function withRetry(operation, operationName, maxRetries = 5) {
  const retryDelays = [10000, 20000, 30000, 40000, 50000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries - 1) throw error;

      await delay(retryDelays[attempt]);
    }
  }
}
```

4. **API Rate Limiting**:

```typescript
// Model-specific error handling
if (error.status === 429) {
  await delay(60000); // Wait 1 minute
  return retry();
}

if (error.status === 503) {
  await delay(30000); // Wait 30 seconds
  return retry();
}
```

5. **Task Stalled**:

```typescript
// Detect stalled tasks (no update in 30 seconds)
function isTaskStalled(task: ImageTask): boolean {
  if (task.status !== "processing") return false;

  const lastUpdate = new Date(task.updated_at).getTime();
  const now = Date.now();
  const stallTimeout = 30000;

  return now - lastUpdate > stallTimeout;
}

// Recovery
if (isTaskStalled(task)) {
  await supabase
    .from("image_tasks")
    .update({ status: "error", error: "Task stalled" })
    .eq("id", task.id);

  // Retry batch
  await triggerNextImage(group_id, user_id, batch_number);
}
```

#### Cleanup on Error

```typescript
async function cleanupFailedGeneration(
  userId: string,
  groupId: string,
  tab: number,
) {
  // 1. Mark all tasks as error
  await supabase
    .from("image_tasks")
    .update({ status: "error", stop_requested: true })
    .eq("group_id", groupId)
    .eq("tab", tab);

  // 2. Delete partial images from storage
  const { data: tasks } = await supabase
    .from("image_tasks")
    .select("batch_output")
    .eq("group_id", groupId)
    .eq("tab", tab);

  const partialUrls = tasks
    .filter((t) => t.batch_output)
    .flatMap((t) => JSON.parse(t.batch_output));

  for (const url of partialUrls) {
    const filePath = extractFilePathFromUrl(url);
    await supabase.storage.from("generated_images").remove([filePath]);
  }

  // 3. Clear session storage
  clearTabSessionStorage(tab);

  // 4. Partial token refund
  const refundAmount = tasks
    .filter((t) => !t.token_updated)
    .reduce((sum, t) => sum + t.tokens, 0);

  if (refundAmount > 0) {
    await supabase.rpc("increment_tokens", {
      user_id: userId,
      amount: refundAmount,
    });
  }
}
```

#### User-Initiated Stop

```typescript
// User clicks stop button
await supabase
  .from("image_tasks")
  .update({ stop_requested: true })
  .eq("group_id", groupId);

// Backend checks before each image
if (task.stop_requested) {
  await supabase
    .from("image_tasks")
    .update({ status: "stopped" })
    .eq("group_id", groupId);

  return { message: "Image generation stopped by user" };
}
```

---

### Token Management

#### Quota Checking

```typescript
// Before generation
const { data: userPlan } = await supabase
  .from("user_plans")
  .select("tokens_used, plan_max, plan_name")
  .eq("user_id", userId)
  .single();

const remaining = userPlan.plan_max - userPlan.tokens_used;
const totalTokens = promptCount * modelTokenCost;

if (totalTokens > remaining) {
  throw new Error(
    `Insufficient tokens. Need ${formatNumber(totalTokens)}, have ${formatNumber(remaining)}`,
  );
}
```

#### Token Tracking

```typescript
// After each batch completes
await supabase.rpc("decrement_tokens", {
  user_id: userId,
  amount: totalTokens,
});

await supabase
  .from("image_tasks")
  .update({ token_updated: true })
  .eq("id", taskId);
```

#### Token History

```sql
-- Track image generation token usage
SELECT
  user_id,
  image_model,
  SUM(tokens) as total_tokens,
  COUNT(*) as images_generated,
  AVG(tokens) as avg_tokens_per_image
FROM image_tasks
WHERE status = 'completed'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY user_id, image_model
ORDER BY total_tokens DESC;
```

---

### Integration with Video Pipeline

When `video_process=true`, images coordinate with video creation:

1. **Completion Check**:

```typescript
async function checkAllStatusesCompleted(
  userId: string,
  groupId: string,
): Promise<boolean> {
  // Check story completion
  const { data: storyDocs } = await supabase
    .from("story_documents")
    .select("*")
    .eq("group_id", groupId)
    .eq("user_id", userId);

  const hasStory = storyDocs && storyDocs.length > 0;

  // Check audio completion
  const { data: audioTasks } = await supabase
    .from("audio_tasks")
    .select("status")
    .eq("group_id", groupId);

  const audioComplete = audioTasks.every(
    (t) => t.status === "completed" || t.status === "completed_final",
  );

  // Check image completion
  const { data: imageTasks } = await supabase
    .from("image_tasks")
    .select("status")
    .eq("group_id", groupId);

  const imagesComplete = imageTasks.every(
    (t) => t.status === "completed" || t.status === "completed_final",
  );

  return hasStory && audioComplete && imagesComplete;
}
```

2. **Trigger Video Creation**:

```typescript
if (await checkAllStatusesCompleted(userId, groupId)) {
  await triggerVideoCreation(userId, groupId);
}
```

3. **Image Requirements for Video**:
   - All images must be 16:9 aspect ratio
   - Images numbered sequentially (image_001.png, image_002.png, ...)
   - Stored in `video_files/{group_id}/images/` folder
   - Image count must match audio segment count
   - Duration per image calculated from audio timing

---

### Monitoring & Debugging

#### Active Tasks

```sql
-- Check active image generation tasks
SELECT
  user_id,
  group_id,
  story_title,
  batch_number,
  total_batches,
  status,
  progress,
  image_model,
  tab,
  updated_at
FROM image_tasks
WHERE status IN ('processing', 'queued')
ORDER BY updated_at DESC;
```

#### Stalled Tasks

```sql
-- Find stalled tasks (no update in 5 minutes)
SELECT
  id,
  group_id,
  batch_number,
  status,
  image_model,
  updated_at,
  EXTRACT(EPOCH FROM (NOW() - updated_at)) as seconds_stalled
FROM image_tasks
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '5 minutes';

-- Reset stalled tasks
UPDATE image_tasks
SET status = 'error',
    error = 'Task stalled - timeout'
WHERE status = 'processing'
  AND updated_at < NOW() - INTERVAL '5 minutes';
```

#### Token Usage by Model

```sql
-- Compare costs across image models
SELECT
  image_model,
  COUNT(*) as images_generated,
  SUM(tokens) as total_tokens,
  AVG(tokens) as avg_tokens_per_image,
  SUM(tokens) * 1.0 / 1000000 as cost_in_millions
FROM image_tasks
WHERE status = 'completed'
  AND created_at > NOW() - INTERVAL '30 days'
GROUP BY image_model
ORDER BY total_tokens DESC;
```

#### Generation Performance

```sql
-- Average generation time per model
SELECT
  image_model,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))) as median_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM image_tasks
WHERE status = 'completed'
GROUP BY image_model
ORDER BY avg_seconds;
```

#### Storage Usage

```sql
-- Check image storage by user
SELECT
  user_id,
  COUNT(*) as total_images,
  SUM(tokens) / 1000000.0 as total_token_cost_millions,
  ROUND(COUNT(*) * 1.0, 2) as estimated_storage_mb
FROM image_tasks
WHERE status = 'completed'
GROUP BY user_id
ORDER BY total_images DESC;
```

#### Regeneration Stats

```sql
-- Track image regeneration frequency
SELECT
  image_model,
  COUNT(*) as total_generations,
  SUM(CASE WHEN redo_status IS NOT NULL THEN 1 ELSE 0 END) as regenerations,
  ROUND(100.0 * SUM(CASE WHEN redo_status IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 2) as redo_percentage
FROM image_tasks
WHERE status = 'completed'
GROUP BY image_model
ORDER BY redo_percentage DESC;
```

---

## Video Generator

The **Video Generator** is the final orchestration layer that combines stories, audio narration, images, and video effects into a complete video file. It manages the entire pipeline from asset preparation through final video compilation, utilizing Google Cloud Functions for heavy video processing tasks.

### Architecture Overview

**Workflow**:

1. **Setup Phase**: User configures video settings, selects assets (story/images/audio), and initiates video task
2. **Asset Preparation**: System validates and prepares all required assets (story document, images folder, audio files)
3. **Sequential Processing**: Based on user settings, system processes story → image prompts → image generation → audio generation → video creation
4. **Batch Video Creation**: Python GCF creates individual videos for each image with synchronized audio segments
5. **Transition Processing**: Optional transitions applied between video clips
6. **Final Assembly**: All individual videos concatenated into final output with background music
7. **Storage & Delivery**: Final video uploaded to Supabase storage and made available for download

**Key Technologies**:

- **Frontend**: React with TypeScript, tab-aware session storage, real-time progress tracking
- **Backend**: Supabase Edge Functions (Deno) for orchestration, Google Cloud Functions (Python) for video processing
- **Video Processing**: FFmpeg for video compilation, MoviePy for transitions, Pydub for audio
- **AI Integration**: Speech-to-text for precise audio-video synchronization (Google Speech-to-Text)
- **Storage**: Supabase Storage with chunked resumable uploads for large video files

**Video Creation Modes**:

1. **Full Pipeline**: Generate everything from scratch (story → prompts → images → audio → video)
2. **Partial Pipeline**: Use existing assets and generate only missing components
3. **Assets Only**: Generate components without final video compilation

### Database Schema: `video_tasks`

The `video_tasks` table tracks the entire video generation lifecycle with 73 columns managing all aspects of the process.

**Core Fields**:

- `id` (uuid): Primary key, auto-generated
- `user_id` (uuid): Owner of the video task
- `group_id` (uuid): Links to related tasks (story, images, audio)
- `story_title` (text): Title of the video/story
- `description` (text): Story description or video summary
- `tab` (integer): Tab number for enterprise users (default: 1)

**Settings & Configuration (JSONB)**:

- `settings` (jsonb): Complete configuration object containing all processing flags and parameters
- `image_style` (text): Style descriptor for image generation
- `use_character_descriptions` (boolean): Whether to extract and use character descriptions
- `first_page_frequency` (integer): Deprecated - Image frequency for first page (seconds, default: 10)
- `rest_frequency` (integer): Deprecated - Image frequency for rest of content (seconds, default: 30)

**Image Frequency Mode (V2 - NEW)**:

- `frequency_mode` (varchar): 'wordcount' or 'audio' - determines segmentation method
- `frequency_type` (varchar): 'variable' or 'consistent' - distribution pattern
- `consistent_frequency` (integer): Seconds per image (when frequency_type='consistent')
- `audio_distribution_type` (varchar): 'consistent' or 'variable' (for audio mode)
- `first_page_image_amount` (integer): Number of images for first page (audio mode, variable)
- `rest_image_amount` (integer): Number of images for rest of content (audio mode, variable)
- `total_audio_duration` (numeric): Calculated audio duration in seconds
- `image_amount` (integer): Total number of images to generate (audio mode, consistent)
- `audio_files` (jsonb): Array of audio file metadata with durations

**Master Prompt (V2 - NEW)**:

- `master_prompt` (text): Enhanced master prompt for visual consistency across story and images
  - Includes visual style, setting, atmosphere, character descriptions
  - Used by both story generation and image prompt generation
  - Ensures narrative and visual coherence throughout entire video

**AI Model Configuration**:

- `image_model` (text): Image generation model (default: 'plus')
- `model` (varchar): AI model for prompt generation (default: 'deepseek')
- `story_model` (varchar): AI model for story generation (default: 'deepseek')

**Voice & Audio Settings**:

- `voice` (text): Selected voice ID
- `language` (text): Audio language (default: 'english')
- `text_language` (text): Text language for STT (default: 'english')
- `model_version` (text): Audio model version (default: 'v6')
- `speed` (real): Audio playback speed (default: 1.0)
- `volume` (numeric): Audio volume (default: 1.0)
- `preference` (text): Audio output preference ('merged' or 'separate', default: 'merged')
- `remove_title_chapters` (boolean): Strip chapter markers (default: false)

**Clone Voice Fields**:

- `is_clone_voice` (boolean): Using voice cloning (default: false)
- `clone_voice_name` (text): Custom voice name
- `clone_voice_url` (text): URL to voice sample file
- `clone_language` (text): Language for cloned voice

**Video Settings**:

- `output_video_name` (text): Final video filename (default: 'final_video.mp4')
- `video` (boolean): Whether to create final video (default: true)
- `animation_type` (text): Animation style for images (default: 'drift')
- `effects_type` (text): Visual effects to apply (default: 'film_grain')
- `transition_type` (text): Transition effect between clips
- `loop_time` (integer): Duration for looped video background

**Background Media**:

- `bg_music` (text): Background music file URL
- `bg_music_volume` (numeric): Background music volume (default: 1.0)
- `video_loop` (text): Looped background video URL

**Asset References**:

- `story_file_path` (text): Path to story document in storage
- `doc_id` (uuid): Dual-purpose pointer. On a **batch sub-row** it points at the parent's `id` (i.e. "this row belongs to that main task"). On a **main row** it is `NULL` and historically also referenced `story_documents`. Do **not** use `doc_id IS NULL` as the test for "is this the main row" — use `is_main` (below).
- `variant` (integer): Story variant number (default: 1)

**Main-Row Identification (`is_main`)**:

A `video_tasks` group consists of exactly one **main row** (the canonical record of the user's request) and zero or more **batch rows** (sub-units created by `create_batch_rows` in `gcloudfunctions/calculate-video-durations*.py` to parallelize image-to-video work). Every reader in the system needs to be able to deterministically pick the main row.

- `is_main` (boolean, NOT NULL, default `false`): `true` exactly on the canonical main row of the group. A partial unique index `video_tasks_one_main_per_tab` enforces `UNIQUE (user_id, group_id, tab) WHERE is_main = true` at the DB level — duplicate mains are impossible by construction.
- `superseded_by` (uuid, nullable, FK → `video_tasks.id`): When `setup-video-tasks` is called twice for the same `(user_id, group_id, tab)` (e.g. user re-runs Components → Video with `use_existing_audio: true`), the previous main is demoted (`is_main = false`) and `superseded_by` is set to the new main's `id`. Demoted rows keep their data for debugging but are filtered out of all reader paths.

**Writer rules**

- Only `supabase/functions/setup-video-tasks/index.ts` creates main rows. It must (a) demote any existing `is_main = true` row for the same `(user_id, group_id, tab)` _before_ inserting and (b) insert the new placeholder with `is_main: true`.
- `create_batch_rows` (Python) inserts batch rows without an `is_main` key, so the column default `false` applies. Batch rows always have `doc_id = main_id`.

**Reader rules**

- "Pick the main row" — server side: `.eq('is_main', true)`. Used by [`assignGcVersion`](supabase/functions/setup-video-tasks/index.ts#L494), [`process-itv-task`](supabase/functions/process-itv-task/index.ts#L363), [`process-ttv-task`](supabase/functions/process-ttv-task/index.ts#L557), [`storyscriptai-setup-prompt`](supabase/functions/storyscriptai-setup-prompt/index.ts#L1413), and the periodic main-row refresh in [`VideoGenerator.tsx`](src/pages/VideoGenerator.tsx#L3964).
- "Pick the main row" — client side from a fetched list: `tasks.find(t => t.is_main)`. Frontend pickers retain a fallback chain `find(t => t.is_main) || find(t => !t.doc_id) || tasks[0]` only as a transitional safety net for cached state during rollout; the second branch becomes dead code once every row in the table has a definitive `is_main` value.
- "Get the batch sub-rows": `tasks.filter(t => t.doc_id)`. Always identify batches by the presence of `doc_id`, never by `!t.is_main` — a demoted-then-orphaned main row has `is_main = false` AND `doc_id IS NULL`, and would be wrongly classified as a batch otherwise.

**Why this matters**

Before `is_main` existed, every reader picked the main row by an ad-hoc heuristic (`videoTasks[0]`, `find(t => !t.doc_id)`, last-updated, …). Different parts of the UI could end up looking at different rows, which surfaced as time-estimate jumps (e.g. 1h 59m → 2h 33m), `total_audio_duration` flickering between non-null and null, and progress bars that disagreed with each other. Centralizing on a DB-enforced flag eliminates the entire class of bug.

**Phase Status Fields** (text: 'pending', 'processing', 'completed', 'error', 'stopped'):

- `story_status`: Story generation phase status
- `image_prompt_status`: Image prompt generation phase status
- `image_generation_status`: Image generation phase status
- `audio_status`: Audio generation phase status
- `individual_video_status`: Individual video creation phase status
- `video_creation_status`: Final video assembly phase status
- `overall_status`: Overall task status

**Progress Fields** (integer: 0-100):

- `story_progress`: Story generation progress percentage
- `image_prompt_progress`: Image prompt progress percentage
- `image_generation_progress`: Image generation progress percentage
- `audio_progress`: Audio generation progress percentage
- `individual_video_progress`: Individual video creation progress percentage
- `video_creation_progress`: Final video assembly progress percentage
- `overall_progress`: Overall task progress percentage

**Processing Flags** (boolean):

- `process_story`: Whether to generate story (default: true)
- `process_images`: Whether to generate images (default: true)
- `process_audio`: Whether to generate audio (default: true)
- `check_status`: Internal flag for status checking (default: false)

**Video Batch Processing**:

- `total_individual_videos` (integer): Total number of image-video pairs to create
- `completed_individual_videos` (integer): Number of completed videos
- `current_image_number` (integer): Currently processing image number
- `processing_batch_start` (integer): Start index of current batch
- `processing_batch_end` (integer): End index of current batch
- `batch_size` (integer): Number of videos per batch
- `current_batch_number` (integer): Current batch number (default: 1)

**Video Durations**:

- `video_durations` (jsonb): Array of durations for each video segment

**Transition Processing**:

- `transition_batch_progress` (jsonb): Progress tracking for transition batches

**Results**:

- `final_video_url` (text): URL to the completed final video
- `error_message` (text): Error details if task failed

**Token Management**:

- `estimated_tokens` (integer): Pre-generation token estimate
- `used_tokens` (integer): Actual tokens consumed

**Timestamps**:

- `created_at` (timestamp): Task creation time
- `updated_at` (timestamp): Last update time
- `completed_at` (timestamp): Completion time

### Frontend Components

#### VideoGeneratorContainer

**Purpose**: Tab wrapper component that manages tab isolation and state cleanup for video generation.

**Key Features**:

- **Tab Configuration Management**: Tracks `groupId` per tab using `tabConfigs` state
- **Component Remounting**: Forces VideoGenerator to remount on tab changes by updating key
- **Cleanup Handler**: Stops video tasks and clears session storage when tabs are closed

**Implementation Pattern**:

```typescript
// Manages multiple tab configurations
const [tabConfigs, setTabConfigs] = useState<Record<number, { groupId: string }>>({});

// Forces remount on tab change
<VideoGenerator
  key={`video-${currentTab}-${tabConfigs[currentTab]?.groupId || 'new'}`}
  // ... props
/>

// Cleanup on tab close
const handleTabClose = async (tab: number, groupId: string) => {
  await stopTasks(currentUserId, groupId);
  // Clear session storage keys...
};
```

#### VideoConfiguration

**Purpose**: Main video generation UI component (2100+ lines) managing configuration, generation, and progress tracking.

**Configuration Steps**:

1. **Asset Selection** (Step 1):
   - **Mode Selection**: Generate new, use existing assets, or mixed approach
   - **Story Configuration**:
     - Generate new story: Description, word count, language, AI model (DeepSeek/Sonnet/Opus)
     - Use existing: Select from story documents
     - Upload: Direct file upload
   - **Image Configuration**:
     - Generate new: Style description, character descriptions, frequencies, image model
     - Use existing: Select folder or upload images
     - Image prompt upload: Use existing prompts document
   - **Audio Configuration**:
     - Generate new: Voice selection (Standard/Core/Premium/Apex/Clone), speed, volume
     - Use existing: Select audio file or folder
     - Upload: Direct audio upload

2. **Video Settings** (Step 2):
   - **Output Name**: Custom filename for final video
   - **Animation Type**: Visual animation for images (drift/zoom/pan)
   - **Effects**: Visual effects (film_grain/vignette/color_grading)
   - **Transitions**: Transition effects between clips (fade/dissolve/wipe)
   - **Background Music**: Upload optional background music (max 100MB)
   - **Background Video Loop**: Upload looped video background with duration
   - **Volume Controls**: Main audio and background music volume sliders

3. **Review & Generate** (Step 3):
   - Token estimate breakdown by phase
   - Storage usage calculation
   - Total cost preview
   - Generation button with validation

**State Management**:

```typescript
const [activeStep, setActiveStep] = useState<number>(1);
const [generationState, setGenerationState] = useState<GenerationState>("idle");
const [batchStatuses, setBatchStatuses] = useState<BatchStatus[]>([]);
const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);

// Tab-aware session storage
const [storyDescription, setStoryDescription] = useTabSessionStorage(
  "storyDescription",
  "",
  currentTab,
);
const [wordCount, setWordCount] = useTabSessionStorage(
  "wordCount",
  1000,
  currentTab,
);
// ... all configuration fields stored per-tab
```

**Progress Tracking**:

- **Real-time Polling**: Uses `calculateVideoProgress()` utility to query individual task tables
- **Phase Breakdown**: Shows progress for story → prompts → images → audio → individual videos → final video
- **Time Estimation**: Calculates remaining time based on completed batches and task timing constants
- **Batch Status UI**: Visual cards showing each phase with status (pending/processing/complete/error)

**File Upload Handling**:

- **TUS Protocol**: Uses `tusUpload.ts` for resumable uploads of large files
- **Validation**: Checks file types, sizes, and storage limits
- **Progress Tracking**: Upload progress displayed with retry logic
- **Storage Management**: Automatic cleanup of temporary files

**Generation Workflow**:

```typescript
const handleGenerate = async () => {
  // 1. Validate all inputs and check token balance
  // 2. Upload any user-provided files (story, images, audio, bg music, video loop)
  // 3. Call setup-video-tasks to create video_tasks record
  // 4. Start pollers for active phases
  // 5. Monitor progress until completion or error
};
```

**Integration with ComponentsCompletionScreen**:

- When `check_status` mode is enabled, shows completion screen with downloadable assets
- Displays generated story, image prompts, images, audio, and final video
- Allows individual download or bulk download of all assets

#### ComponentsCompletionScreen

**Purpose**: Displays generated assets and provides download functionality after video generation completes.

**Key Features**:

- **Asset Display**: Shows story text, image prompts, generated images grid, audio player, video player
- **Download Options**: Individual downloads or bulk download all
- **Storage Paths**: Fetches actual file paths from database and generates signed URLs
- **Image Preview**: Grid layout with lazy loading for large image sets
- **Streaming Downloads**: Uses `handleStreamingDownload` for large files with progress tracking

#### TabManager

**Purpose**: Multi-tab interface for enterprise users to manage multiple concurrent video generation tasks.

**Key Features**:

- **Tab Creation**: Create up to 10 tabs with unique `group_id` per tab
- **Status Indicators**: Color-coded borders showing tab status (idle/processing/complete/error)
- **Token Estimates**: Shows estimated token usage per tab
- **Tab Switching**: Seamless switching between tabs with state preservation
- **Tab Closure**: Cleanup handler stops tasks and removes session storage

**Tab Status Colors**:

- Green: Completed
- Blue: Processing
- Red: Error
- Gray: Idle

### Backend Functions

#### 1. setup-video-tasks

**File**: `supabase/functions/setup-video-tasks/index.ts` (1881 lines)

**Purpose**: Initializes video task, validates all inputs, uploads assets, and triggers the first phase of generation.

**Request Payload**:

```typescript
{
  user_id: string;
  group_id: string;
  story_title: string;
  description: string;

  // Asset processing flags
  process_story: boolean;
  process_images: boolean;
  process_audio: boolean;
  video: boolean; // Create final video
  check_status: boolean; // Assets-only mode

  // Story settings
  story_description?: string;
  word_count?: number;
  story_language?: string;
  story_model?: string;
  use_existing_story?: boolean;
  story_file_path?: string;

  // Image settings
  image_style?: string;
  use_character_descriptions?: boolean;
  first_page_frequency?: number;
  rest_frequency?: number;
  image_model?: string;
  use_existing_images?: boolean;
  images_folder_path?: string;
  image_prompt_path?: string;

  // Audio settings
  voice?: string;
  language?: string;
  model_version?: string;
  speed?: number;
  volume?: number;
  preference?: string;
  remove_title_chapters?: boolean;
  is_clone_voice?: boolean;
  clone_voice_name?: string;
  clone_voice_url?: string;
  clone_language?: string;
  use_existing_audio?: boolean;
  audio_file_path?: string;
  audio_folder_path?: string;

  // Video settings
  output_video_name?: string;
  animation_type?: string;
  effects_type?: string;
  transition_type?: string;
  bg_music?: string;
  bg_music_volume?: number;
  video_loop?: string;
  loop_time?: number;

  tab?: number;
}
```

**Processing Steps**:

1. **Input Validation**:
   - Validates required fields (user_id, group_id, story_title)
   - Validates word count limits based on model
   - Validates asset paths and URLs
   - Checks voice type and configuration
   - Validates file paths exist in storage

2. **Asset Path Processing**:
   - If using existing story: Verifies file exists, extracts word count
   - If using existing images: Counts images in folder using `countImagesInFolder()`
   - If using existing audio: Detects type (single file or folder)
   - Sanitizes output filename using `sanitizeFilename()`

3. **Token Estimation**:
   - Story tokens: Based on word count and model multiplier
   - Image prompt tokens: Based on segments and model multiplier
   - Image generation tokens: Based on image count and model cost
   - Audio tokens: Based on word count and voice tier multiplier
   - Transition tokens: Based on number of images and transition type
   - Total estimate stored in `estimated_tokens`

4. **Video Task Creation**:

   ```typescript
   const { data: videoTask, error: insertError } = await supabase
     .from("video_tasks")
     .insert({
       user_id,
       group_id,
       story_title,
       description,
       settings: {
         process_story,
         process_images,
         process_audio,
         video,
         // ... all configuration
       },
       // ... all individual fields
       tab,
       overall_status: "processing",
     })
     .select()
     .single();
   ```

5. **Phase Triggering**:
   - If `process_story === true` and no existing story: Call `setup-story-tasks`
   - If `process_story === false` or existing story: Mark story as completed
   - If story already completed: Trigger next phase (image prompts or audio)
   - Uses waterfall logic: story → image prompts → images → audio → video creation

**Response**:

```json
{
  "video_task_id": "uuid",
  "group_id": "uuid",
  "message": "Video task setup successfully",
  "triggered_phase": "story" | "image_prompts" | "audio" | "none"
}
```

**Error Handling**:

- Validates token balance before processing
- Logs errors to `error_logs` table with full context
- Returns detailed error messages for debugging
- Rolls back task creation on failure

#### 2. trigger-next-video

**File**: `supabase/functions/trigger-next-video/index.ts` (614 lines)

**Purpose**: Queue management function that determines next batch to process and triggers appropriate Google Cloud Function.

**Request Payload**:

```typescript
{
  video_task_id: string;
  user_id: string;
  group_id: string;
  individual_videos_paths?: string[]; // Completed video paths
  next_step: 'process_images' | 'create_final_video';
  completed_batch?: number;
  tab?: number;
}
```

**Processing Logic**:

1. **Determine Next Action**:

   ```typescript
   if (next_step === "process_images") {
     await triggerImageProcessing(data);
   } else if (next_step === "create_final_video") {
     await triggerCreateFinalVideo(data);
   }
   ```

2. **Image Processing Workflow** (`triggerImageProcessing`):
   - Query video task to get settings and status
   - Count total images in folder
   - Calculate batch size based on memory requirements
   - Fetch next unprocessed batch using `getNextBatchToProcess()`
   - Call `image-to-video-processor` GCF asynchronously with retry logic
   - Update video task with batch progress

3. **Batch Selection** (`getNextBatchToProcess`):

   ```typescript
   // Finds next batch that hasn't been processed
   const batchInfo = {
     batch_number: current_batch_number,
     batch_start: (current_batch_number - 1) * batch_size + 1,
     batch_end: Math.min(current_batch_number * batch_size, total_images),
     total_batches: Math.ceil(total_images / batch_size),
   };
   ```

4. **Final Video Workflow** (`triggerCreateFinalVideo`):
   - Verify all individual videos completed
   - Check if transitions are enabled
   - If transitions: Call `process-transition-batches`
   - If no transitions: Call `create-final-video` GCF directly
   - Update status to 'processing' and track progress

5. **Progress Tracking** (`checkVideoTaskProgress`):
   - Calculates overall progress across all phases
   - Updates `overall_progress` field
   - Determines when all phases are complete

**Fire-and-Forget Pattern**:

```typescript
// GCF calls are async without waiting for response
async function triggerBatchProcessingAsync(data, batchInfo) {
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const response = await fetch(GCF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) break;
    } catch (error) {
      retries++;
      await new Promise((r) => setTimeout(r, 2000 * retries));
    }
  }
}
```

**Response**:

```json
{
  "message": "Triggered image processing batch X" | "Triggered create-final-video",
  "batch_number": 1,
  "total_batches": 5,
  "images_in_batch": 10
}
```

#### 3. process-transition-batches

**File**: `supabase/functions/process-transition-batches/index.ts` (142 lines)

**Purpose**: Applies transition effects between video clips before final assembly.

**Request Payload**:

```typescript
{
  video_task_id: string;
  user_id: string;
  group_id: string;
  continue_from_batch?: number;
  transition_type?: string;
  transition_duration?: number;
  final_assembly?: boolean;
  tab?: number;
}
```

**Processing Logic**:

- Updates video task status to 'processing_transitions'
- Calls Python GCF to apply transition effects using MoviePy
- Tracks progress in `transition_batch_progress` JSONB field
- After all transitions complete, triggers final video assembly

**Transition Types**:

- `fade`: Crossfade between clips
- `dissolve`: Dissolve transition
- `wipe`: Wipe transition effect

**Token Cost**:

- Transitions add additional token cost based on number of images
- Formula: `Math.ceil(num_images / 10) * 2000` tokens per batch

#### 4. image-to-video-processor (Python GCF)

**File**: `gcloudfunctions/image-to-video-processor.py` (3512 lines)

**Purpose**: Core video creation function that converts images to videos with synchronized audio using Speech-to-Text for precision timing.

**Request Payload**:

```python
{
  'video_task_id': str,
  'user_id': str,
  'group_id': str,
  'images_folder': str,
  'prompts_path': str,
  'story_path': str,
  'audio_path': str,
  'output_folder': str,
  'batch_start': int,
  'batch_end': int,
  'animation_type': str,
  'effects_type': str,
  'text_language': str,
  'model_version': str,
  'tab': int
}
```

**Key Classes & Methods**:

**STTDurationProcessor**:

- **Purpose**: Uses Google Speech-to-Text to get precise word-level timestamps for audio synchronization
- **Methods**:
  - `process_audio_file()`: Uploads audio to GCS, calls STT API, retrieves word timestamps
  - `get_segment_durations()`: Maps text segments to audio timestamps with high precision
  - `match_prompts_to_timestamps()`: Aligns image prompts with their corresponding audio segments

**Video Creation Pipeline**:

1. **Asset Download**:

   ```python
   # Download images from Supabase storage
   for i in range(batch_start, batch_end + 1):
       image_path = f"{images_folder}/image_{i}.jpg"
       download_file(signed_url, local_path, headers)

   # Download and merge audio files (if folder)
   merged_audio = download_and_merge_audio_files(audio_path, temp_dir)

   # Download story and prompts documents
   story_content = download_file(story_path)
   prompts_content = download_file(prompts_path)
   ```

2. **Text Segmentation & Parsing**:

   ```python
   # Parse prompts document to extract segments
   segments = parse_image_prompt_document(prompts_content)
   # segments = [
   #   {'image_number': 1, 'prompt': '...', 'text': '...'},
   #   {'image_number': 2, 'prompt': '...', 'text': '...'},
   # ]
   ```

3. **Speech-to-Text Processing**:

   ```python
   stt_processor = STTDurationProcessor(supabase, video_task_id, user_id)

   # Get precise word-level timestamps
   segment_durations = stt_processor.get_segment_durations_using_enhanced_stt(
       audio_path=merged_audio,
       text_segments=segments,
       story_content=story_content,
       prompt_content=prompts_content,
       text_language=text_language,
       timestamp_level='sentence'  # or 'word' for maximum precision
   )

   # Returns: [
   #   {'image_number': 1, 'duration': 5.23, 'start_time': 0.0, 'end_time': 5.23},
   #   {'image_number': 2, 'duration': 4.87, 'start_time': 5.23, 'end_time': 10.10},
   # ]
   ```

4. **Video Creation Per Image**:

   ```python
   for segment in segment_durations:
       image_num = segment['image_number']
       duration = segment['duration']
       start_time = segment['start_time']
       end_time = segment['end_time']

       # Load image
       image_clip = ImageClip(f"temp/image_{image_num}.jpg").set_duration(duration)

       # Apply animation
       if animation_type == 'drift':
           image_clip = apply_drift_animation(image_clip)
       elif animation_type == 'zoom':
           image_clip = apply_zoom_animation(image_clip)

       # Extract audio segment
       audio_segment = AudioFileClip(merged_audio).subclip(start_time, end_time)

       # Combine image and audio
       video = image_clip.set_audio(audio_segment)

       # Apply effects
       if effects_type == 'film_grain':
           video = apply_film_grain(video)

       # Write to file
       output_path = f"temp/video_{image_num}.mp4"
       video.write_videofile(output_path, codec='libx264', audio_codec='aac', fps=24)

       # Upload to Supabase
       upload_path = f"{output_folder}/video_{image_num}.mp4"
       upload_to_supabase(output_path, upload_path)
   ```

5. **Token Deduction**:

   ```python
   # Calculate STT tokens used
   audio_duration_seconds = get_audio_duration(merged_audio)
   stt_tokens = calculate_stt_tokens(audio_duration_seconds)
   # Formula: (audio_duration / 60) * 4000 tokens per minute

   # Deduct from user balance
   check_user_token_balance(supabase, user_id, stt_tokens)
   ```

6. **Progress Updates**:

   ```python
   # Update after each video completed
   completed_count = current_batch_progress
   total_count = batch_end - batch_start + 1
   progress_percent = (completed_count / total_count) * 100

   supabase.table('video_tasks').update({
       'completed_individual_videos': completed_count,
       'individual_video_progress': progress_percent,
       'updated_at': datetime.now()
   }).eq('id', video_task_id).execute()
   ```

7. **Batch Completion**:
   ```python
   if all videos completed:
       # Trigger next batch or final assembly
       trigger_next_video({
           'video_task_id': video_task_id,
           'next_step': 'process_images' if more_batches else 'create_final_video',
           'completed_batch': current_batch_number
       })
   ```

**Stop Request Handling**:

```python
def handle_stop_request(supabase, video_task_id, user_id, group_id):
    # Check if task was stopped
    task = supabase.table('video_tasks').select('overall_status').eq('id', video_task_id).single()
    if task['overall_status'] == 'stopped':
        # Cleanup temp files
        # Delete partial uploads from storage
        # Update status and exit gracefully
        return True
    return False
```

**Error Handling**:

- Retries on network failures (3 attempts with exponential backoff)
- Validates all file downloads before processing
- Logs detailed errors to `error_logs` table
- Cleans up temporary files on error
- Updates video task status to 'error' with message

#### 5. create-final-video (Python GCF)

**File**: `gcloudfunctions/create-final-video.py` (2482 lines)

**Purpose**: Assembles all individual videos into final output with background music and optional video loop.

**Request Payload**:

```python
{
  'video_task_id': str,
  'user_id': str,
  'group_id': str,
  'video_paths': List[str],  # Paths to individual videos
  'audio_path': str,         # Path to merged audio
  'output_path': str,        # Final video destination
  'bg_music_url': str,       # Optional background music
  'bg_music_volume': float,  # Background music volume (0.0-1.0)
  'video_loop_url': str,     # Optional looped background video
  'loop_time': int,          # Loop duration in seconds
  'audio_delay': float,      # Delay before audio starts (default: 0.4s)
  'tab': int
}
```

**Processing Modes**:

**Mode 1: Image-Based Video** (default):

1. Download all individual video files from storage
2. Concatenate videos in sequence
3. Optionally add background music
4. Upload final video to storage

**Mode 2: Video Loop with Audio**:

1. Download looped background video
2. Extend loop to match audio duration
3. Overlay audio on video
4. Add background music if provided
5. Upload final video

**Implementation**:

1. **Download Individual Videos**:

   ```python
   local_video_files = []
   for i, video_path in enumerate(video_paths):
       signed_url = generate_signed_url(video_path)
       local_path = f"temp/video_{i}.mp4"
       download_file(signed_url, local_path)
       local_video_files.append(local_path)
   ```

2. **Video Concatenation**:

   ```python
   from moviepy.editor import VideoFileClip, concatenate_videoclips

   # Load all video clips
   clips = [VideoFileClip(path) for path in local_video_files]

   # Concatenate
   final_clip = concatenate_videoclips(clips, method='compose')

   # Get total duration
   total_duration = final_clip.duration
   ```

3. **Background Music Integration**:

   ```python
   if bg_music_url:
       # Download background music
       bg_music_path = download_background_music(bg_music_url, temp_dir)

       # Load and loop music to match video duration
       bg_audio = AudioFileClip(bg_music_path)

       # Loop music if shorter than video
       if bg_audio.duration < total_duration:
           num_loops = math.ceil(total_duration / bg_audio.duration)
           bg_audio = concatenate_audioclips([bg_audio] * num_loops).subclip(0, total_duration)
       else:
           bg_audio = bg_audio.subclip(0, total_duration)

       # Adjust volume
       bg_audio = bg_audio.volumex(bg_music_volume)

       # Mix with existing audio
       from moviepy.audio.AudioClip import CompositeAudioClip
       if final_clip.audio:
           mixed_audio = CompositeAudioClip([final_clip.audio, bg_audio])
       else:
           mixed_audio = bg_audio

       final_clip = final_clip.set_audio(mixed_audio)
   ```

4. **Video Loop Mode**:

   ```python
   def create_looped_video(video_path, target_duration, audio_delay):
       # Load video
       video = VideoFileClip(video_path)
       video_duration = video.duration

       # Calculate loops needed
       num_loops = math.ceil((target_duration + audio_delay) / video_duration)

       # Loop video
       looped = concatenate_videoclips([video] * num_loops)

       # Trim to exact duration
       looped = looped.subclip(0, target_duration + audio_delay)

       return looped

   def combine_loop_video_with_audio(loop_video_path, audio_path, bg_music_path, output_path, bg_music_volume, audio_delay):
       # Load looped video
       video = VideoFileClip(loop_video_path)

       # Load audio and add delay
       audio = AudioFileClip(audio_path).set_start(audio_delay)

       # Add background music if provided
       if bg_music_path:
           bg_music = AudioFileClip(bg_music_path).volumex(bg_music_volume)
           mixed_audio = CompositeAudioClip([audio, bg_music])
       else:
           mixed_audio = audio

       # Set audio to video
       final = video.set_audio(mixed_audio)

       # Write output
       final.write_videofile(output_path, codec='libx264', audio_codec='aac', fps=24, bitrate='5000k')
   ```

5. **File Size Estimation & Memory Delegation**:

   ```python
   def estimate_final_video_size(loop_video_path, target_duration, local_video_files, audio_path):
       # Estimate based on input files and duration
       estimated_size_gb = (target_duration / 60) * 0.5  # ~500MB per minute
       return estimated_size_gb

   def delegate_to_high_memory(request_data):
       # If estimated size > 5GB, delegate to high-memory GCF
       HIGH_MEMORY_GCF_URL = 'https://...-create-final-video-high-memory'
       response = requests.post(HIGH_MEMORY_GCF_URL, json=request_data)
       return response

   # In main handler:
   estimated_size = estimate_final_video_size(...)
   if estimated_size > 5.0:
       return delegate_to_high_memory(request_data)
   ```

6. **Chunked Upload with Resumability**:

   ```python
   def upload_file_chunked_resumable(supabase_url, supabase_key, file_path, upload_path, chunk_size=6*1024*1024):
       file_size = os.path.getsize(file_path)
       num_chunks = math.ceil(file_size / chunk_size)

       with open(file_path, 'rb') as f:
           for chunk_num in range(num_chunks):
               chunk_data = f.read(chunk_size)

               # Upload chunk with retry
               for attempt in range(3):
                   try:
                       response = requests.post(
                           f"{supabase_url}/storage/v1/object/videos/{upload_path}",
                           headers={
                               'Authorization': f'Bearer {supabase_key}',
                               'Content-Range': f'bytes {chunk_num*chunk_size}-{chunk_num*chunk_size+len(chunk_data)-1}/{file_size}'
                           },
                           data=chunk_data
                       )
                       if response.ok:
                           break
                   except Exception as e:
                       if attempt == 2:
                           raise
                       time.sleep(2 ** attempt)

               # Update progress
               progress = ((chunk_num + 1) / num_chunks) * 100
               update_progress(video_task_id, progress)
   ```

7. **Token Deduction**:

   ```python
   # Calculate transition tokens if applicable
   num_images = len(video_paths)
   transition_tokens = calculate_transition_tokens(num_images, has_transitions)

   # Deduct tokens
   check_user_token_balance(supabase, user_id, transition_tokens)
   ```

8. **Final Updates**:
   ```python
   # Update video task with final video URL
   supabase.table('video_tasks').update({
       'final_video_url': public_url,
       'video_creation_status': 'completed',
       'video_creation_progress': 100,
       'overall_status': 'completed',
       'overall_progress': 100,
       'completed_at': datetime.now().isoformat()
   }).eq('id', video_task_id).execute()
   ```

**Response**:

```json
{
  "status": "success",
  "final_video_url": "https://...supabase.co/storage/v1/object/public/videos/...",
  "file_size_mb": 256.7,
  "duration_seconds": 180.5,
  "tokens_used": 2000
}
```

#### 6. create-final-video-high-memory (Python GCF)

**File**: `gcloudfunctions/create-final-video-high-memory.py` (2322 lines)

**Purpose**: High-memory variant of final video assembly for large videos (>5GB estimated).

**Differences from Standard Version**:

- Allocated 8GB+ memory vs. 2GB
- Optimized for longer videos and higher resolutions
- Same API and processing logic as standard version
- Automatically invoked by standard version when needed

#### 7. boost-audio-volume (Python GCF)

**File**: `gcloudfunctions/boost-audio-volume.py` (253 lines)

**Purpose**: Utility function to increase audio volume for quiet recordings.

**Request Payload**:

```python
{
  'audio_path': str,         # Path to audio file or folder
  'volume_multiplier': float, # Volume boost multiplier (e.g., 2.0 = 2x louder)
  'user_id': str
}
```

**Processing**:

1. Download audio file(s) from storage
2. Apply volume boost using Pydub
3. Re-upload boosted audio to same path
4. Return success confirmation

**Usage**:

- Called when user reports audio too quiet
- Can process single file or entire folder
- Preserves original file format

### User Workflows

#### Workflow 1: Full Pipeline Video Generation

**Scenario**: Generate complete video from story description.

**Steps**:

1. User enters story description, word count, selects AI models
2. Configures image generation settings (style, frequencies, model)
3. Selects voice and audio settings
4. Configures video settings (animation, effects, transitions)
5. Reviews token estimate and clicks "Generate Video"

**Backend Flow**:

```
setup-video-tasks
  ↓ (creates video_tasks record, triggers first phase)
setup-story-tasks
  ↓ (creates story_tasks record)
storyscriptai-outline → storyscriptai-parse → process-story
  ↓ (story completes, triggers next phase)
setup-image-prompt-tasks
  ↓ (creates image_prompt_tasks record)
storyscriptai-setup-prompt → process-image-batch → generate-image-prompts
  ↓ (prompts complete, triggers next phase)
setup-image-tasks
  ↓ (creates image_tasks record)
process-image → generate-image (for each image)
  ↓ (images complete, triggers next phase)
setup-audio-tasks
  ↓ (creates audio_tasks record)
process-audio-batch → generate-audio-segments
  ↓ (audio complete, triggers next phase)
trigger-next-video (next_step: 'process_images')
  ↓ (initiates video creation batches)
image-to-video-processor (batch 1)
  ↓ (creates videos 1-10, triggers next batch)
image-to-video-processor (batch 2)
  ↓ (creates videos 11-20, continues until all batches complete)
trigger-next-video (next_step: 'create_final_video')
  ↓ (if transitions enabled)
process-transition-batches
  ↓ (applies transitions, then triggers final)
create-final-video
  ↓ (assembles final video with background music)
Complete!
```

**Timeline**:

- Story (5000 words): ~5 minutes
- Image Prompts: ~3 minutes
- Image Generation (50 images): ~25 minutes
- Audio Generation: ~3 minutes
- Individual Videos (50): ~20 minutes
- Final Assembly: ~5 minutes
- **Total**: ~60 minutes

#### Workflow 2: Use Existing Assets

**Scenario**: User has pre-generated story, images, and audio; just wants to compile video.

**Steps**:

1. Select "Use Existing" for story, images, and audio
2. Choose files from document library
3. Configure video settings (animation, effects, background music)
4. Click "Generate Video"

**Backend Flow**:

```
setup-video-tasks (all process_* flags = false)
  ↓ (validates assets exist, triggers video creation immediately)
trigger-next-video (next_step: 'process_images')
  ↓
image-to-video-processor (all batches)
  ↓
create-final-video
  ↓
Complete!
```

**Timeline**: ~25-30 minutes (video creation only)

#### Workflow 3: Partial Pipeline

**Scenario**: User has story and images, needs to generate audio and compile video.

**Steps**:

1. Select existing story document
2. Select existing images folder
3. Configure audio generation (voice, settings)
4. Configure video settings
5. Generate

**Backend Flow**:

```
setup-video-tasks (process_story=false, process_images=false, process_audio=true)
  ↓
setup-audio-tasks
  ↓
process-audio-batch → generate-audio-segments
  ↓
trigger-next-video → image-to-video-processor → create-final-video
  ↓
Complete!
```

**Timeline**: ~30-35 minutes (audio + video)

#### Workflow 4: Assets Only Mode

**Scenario**: User wants to generate all components but download them individually without creating final video.

**Steps**:

1. Configure story, images, audio settings
2. Enable "Assets Only" mode (check_status = true)
3. Generate

**Backend Flow**:

```
setup-video-tasks (video=false, check_status=true)
  ↓
Generate story → Generate prompts → Generate images → Generate audio
  ↓
ComponentsCompletionScreen displayed with download options
```

**Timeline**: ~40 minutes (no video compilation)

#### Workflow 5: Video Loop Background

**Scenario**: User wants to create video with custom looped background video instead of static images.

**Steps**:

1. Generate or upload story and audio
2. Skip image generation (process_images = false)
3. Upload background video loop file
4. Set loop duration
5. Configure audio delay and background music
6. Generate

**Backend Flow**:

```
setup-video-tasks (process_images=false, video_loop provided)
  ↓
Generate story and audio
  ↓
create-final-video (video loop mode)
  → create_looped_video() → combine_loop_video_with_audio()
  ↓
Complete!
```

**Timeline**: ~15-20 minutes (faster without image processing)

### Progress Calculation

#### Real-Time Progress Tracking

The system uses `videoProgressCalculator.ts` to query individual task tables directly rather than relying on cached progress values in `video_tasks`.

**Why Direct Queries?**

- Pollers update React state but don't always update database
- Aggregated progress fields can become stale
- Direct queries ensure displayed progress is always accurate

**Implementation**:

```typescript
// calculateVideoProgress() queries each task table
export async function calculateVideoProgress(
  userId: string,
  groupId: string,
  processFlags: ProcessFlags,
): Promise<BatchStatus[]> {
  const statuses: BatchStatus[] = [];

  // Query story_tasks if story processing enabled
  if (processFlags.process_story) {
    const storyProgress = await queryStoryProgress(userId, groupId);
    statuses.push({
      id: "story",
      label: "Story Generation",
      status: storyProgress.status,
      progress: storyProgress.progress,
    });
  }

  // Query image_prompt_tasks if prompt processing enabled
  if (processFlags.process_images && processFlags.process_story) {
    const promptProgress = await queryImagePromptProgress(userId, groupId);
    statuses.push({
      id: "image_prompts",
      label: "Image Prompts",
      status: promptProgress.status,
      progress: promptProgress.progress,
    });
  }

  // Query image_tasks if image processing enabled
  if (processFlags.process_images) {
    const imageProgress = await queryImageGenerationProgress(userId, groupId);
    statuses.push({
      id: "images",
      label: "Image Generation",
      status: imageProgress.status,
      progress: imageProgress.progress,
    });
  }

  // Query audio_tasks if audio processing enabled
  if (processFlags.process_audio) {
    const audioProgress = await queryAudioProgress(userId, groupId);
    statuses.push({
      id: "audio",
      label: "Audio Generation",
      status: audioProgress.status,
      progress: audioProgress.progress,
    });
  }

  // Query video_tasks for video creation phases
  const videoProgress = await queryVideoProgress(userId, groupId);
  statuses.push(...videoProgress);

  return statuses;
}
```

**Progress Formulas by Phase**:

1. **Story Progress**:

   ```typescript
   // Formula: (completedBatches + runningProgress/100) / totalBatches * 100
   const { data: tasks } = await supabase
     .from("story_tasks")
     .select("batch, status, progress, total_batches")
     .eq("user_id", userId)
     .eq("group_id", groupId);

   const completedCount = tasks.filter((t) => t.status === "completed").length;
   const runningTask = tasks.find((t) => t.status === "processing");
   const runningProgress = runningTask ? runningTask.progress : 0;
   const totalBatches = tasks[0]?.total_batches || 1;

   const progress =
     ((completedCount + runningProgress / 100) / totalBatches) * 100;
   ```

2. **Image Generation Progress**:

   ```typescript
   // Formula: (totalProgress / (totalBatches * 100)) * 100
   const { data: tasks } = await supabase
     .from("image_tasks")
     .select("batch, progress, total_batches")
     .eq("user_id", userId)
     .eq("group_id", groupId);

   const totalProgress = tasks.reduce((sum, t) => sum + t.progress, 0);
   const totalBatches = tasks[0]?.total_batches || 1;

   const progress = (totalProgress / (totalBatches * 100)) * 100;
   ```

3. **Individual Video Progress**:

   ```typescript
   // From video_tasks table
   const { data: videoTask } = await supabase
     .from("video_tasks")
     .select("completed_individual_videos, total_individual_videos")
     .eq("id", videoTaskId)
     .single();

   const progress =
     (videoTask.completed_individual_videos /
       videoTask.total_individual_videos) *
     100;
   ```

4. **Final Video Progress**:

   ```typescript
   // Simple status-based tracking
   const { data: videoTask } = await supabase
     .from("video_tasks")
     .select("video_creation_status, video_creation_progress")
     .eq("id", videoTaskId)
     .single();

   // progress = 0 (pending), 50 (processing), 100 (completed)
   ```

#### Time Estimation

**Timing Constants** (from `storyTaskPolling.ts`):

```typescript
const TIMING = {
  STORY_BATCH: 90, // 90 seconds per story batch
  IMAGE_PROMPT_BATCH: 90, // 90 seconds per prompt batch
  IMAGE_GENERATION: 30, // 30 seconds per image
  AUDIO_BATCH_STANDARD: 20, // 20 seconds per audio batch (standard voices)
  AUDIO_BATCH_PREMIUM: 10, // 10 seconds per audio batch (premium voices)
  AUDIO_BATCH_CORE: 10, // 10 seconds per audio batch (core voices)
  AUDIO_BATCH_CLONE: 10, // 10 seconds per audio batch (clone voices)
  VIDEO_BATCH: 30 * 60, // 30 minutes per video batch (individual videos)
  TRANSITION_BATCH: 30 * 60, // 30 minutes per transition batch
};
```

**Calculation**:

```typescript
function calculateRemainingTime(
  completedBatches: number,
  totalBatches: number,
  phase: string,
  voiceType?: string,
): number {
  const remainingBatches = totalBatches - completedBatches;

  let timePerBatch: number;
  if (phase === "story") {
    timePerBatch = TIMING.STORY_BATCH;
  } else if (phase === "audio") {
    timePerBatch = isStandardVoice(voiceType)
      ? TIMING.AUDIO_BATCH_STANDARD
      : TIMING.AUDIO_BATCH_PREMIUM;
  } else if (phase === "video") {
    timePerBatch = TIMING.VIDEO_BATCH;
  }
  // ... other phases

  return remainingBatches * timePerBatch;
}
```

**Display**:

```typescript
// Format as human-readable time
const formatTime = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};
```

### Token Management

#### Token Calculation

**Story Tokens**:

```typescript
const storyTokens = (wordCount / 200) * 1000 * modelMultiplier;
// DeepSeek: 1x, Sonnet: 10x, Opus: 48x
```

**Image Prompt Tokens**:

```typescript
const segments = Math.ceil(totalChars / charsPerSegment);
const promptTokens = segments * 100 * modelMultiplier;
// DeepSeek: 1x, Sonnet: 10x, Opus: 48x
```

**Image Generation Tokens**:

```typescript
const imageTokens = imageCount * IMAGE_MODEL_TOKENS[imageModel];
// Spark: 7000, Lite: 14000, Core: 30000, Prime: 35000, Heavy: 42000, Genesis: 100000
```

**Audio Tokens**:

```typescript
const audioTokens = (wordCount / 200) * 1000 * voiceMultiplier;
// Standard: 1x, Core: 2x, Premium: 3x, Apex: 8x, Clone: 10x
```

**STT Tokens** (Speech-to-Text):

```typescript
const sttTokens = audioDurationMinutes * 4000;
// 4000 tokens per minute of audio
```

**Transition Tokens**:

```typescript
const transitionBatches = Math.ceil(imageCount / 10);
const transitionTokens = transitionBatches * 2000;
// 2000 tokens per batch of 10 transitions
```

**Total Estimate**:

```typescript
const totalTokens =
  storyTokens +
  promptTokens +
  imageTokens +
  audioTokens +
  sttTokens +
  transitionTokens;
```

#### Token Balance Checking

**Pre-Generation Check**:

```typescript
// In setup-video-tasks
const { data: profile } = await supabase
  .from("profiles")
  .select("token_balance, plan")
  .eq("id", user_id)
  .single();

if (profile.token_balance < estimated_tokens) {
  throw new Error("Insufficient token balance");
}
```

**Incremental Deduction**:

```python
# In Python GCFs after each phase
def check_user_token_balance(supabase, user_id, tokens_to_add):
    profile = supabase.table('profiles').select('token_balance').eq('id', user_id).single()

    if profile['token_balance'] < tokens_to_add:
        raise Exception('Insufficient tokens')

    # Deduct tokens
    new_balance = profile['token_balance'] - tokens_to_add
    supabase.table('profiles').update({
        'token_balance': new_balance,
        'used_tokens': profile['used_tokens'] + tokens_to_add
    }).eq('id', user_id).execute()

    # Update video_tasks
    supabase.table('video_tasks').update({
        'used_tokens': video_task['used_tokens'] + tokens_to_add
    }).eq('id', video_task_id).execute()
```

### Error Handling

#### Frontend Error Display

```typescript
// Error state management
const [error, setError] = useState<string | null>(null);

// Polling error handler
const handlePollerError = (phase: string, errorMessage: string) => {
  setError(`${phase} error: ${errorMessage}`);
  setGenerationState('error');
  stopAllPollers();
};

// Display error to user
{error && (
  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
    <h4 className="text-red-800 font-medium">Generation Error</h4>
    <p className="text-red-600 text-sm mt-1">{error}</p>
    <button onClick={handleRetry}>Retry</button>
  </div>
)}
```

#### Backend Error Logging

```typescript
// In Supabase Edge Functions
async function logError(message: string, error: any) {
  console.error(`${message}:`, error);
  try {
    await supabase.from("error_logs").insert({
      message,
      details: error.message || JSON.stringify(error),
      function_name: "setup-video-tasks",
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Failed to log error:", err);
  }
}
```

```python
# In Python GCFs
import traceback

try:
    # Processing logic
    pass
except Exception as e:
    error_details = traceback.format_exc()

    # Log to database
    supabase.table('error_logs').insert({
        'message': str(e),
        'details': error_details,
        'function_name': 'image-to-video-processor',
        'video_task_id': video_task_id,
        'created_at': datetime.now().isoformat()
    }).execute()

    # Update video task
    supabase.table('video_tasks').update({
        'overall_status': 'error',
        'error_message': str(e)
    }).eq('id', video_task_id).execute()

    raise
```

#### Retry Logic

**Network Retry**:

```python
def download_file_with_retry(url, local_path, max_retries=5):
    for attempt in range(max_retries):
        try:
            response = requests.get(url, stream=True, timeout=30)
            response.raise_for_status()

            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            return True
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)  # Exponential backoff

    return False
```

**GCF Trigger Retry**:

```typescript
async function triggerBatchProcessingAsync(data, batchInfo) {
  let retries = 0;
  const maxRetries = 3;

  while (retries < maxRetries) {
    try {
      const response = await fetch(GCF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000), // 60s timeout
      });

      if (response.ok) {
        console.log("Successfully triggered batch processing");
        break;
      }
    } catch (error) {
      retries++;
      console.error(`Retry ${retries}/${maxRetries}:`, error);

      if (retries < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000 * retries));
      } else {
        await logError("Failed to trigger GCF after retries", error);
      }
    }
  }
}
```

#### Graceful Degradation

**Stop Request Handling**:

```typescript
// Frontend: User clicks stop
const handleStop = async () => {
  try {
    // Update video task status
    await supabase
      .from("video_tasks")
      .update({ overall_status: "stopped" })
      .eq("id", currentGroupId);

    // Stop all pollers
    stopAllPollers();

    // Update UI
    setGenerationState("idle");
    setStatusMessage("Generation stopped by user");
  } catch (error) {
    console.error("Error stopping generation:", error);
  }
};
```

```python
# Backend: Check for stop requests periodically
def handle_stop_request(supabase, video_task_id, user_id, group_id):
    task = supabase.table('video_tasks').select('overall_status').eq('id', video_task_id).single()

    if task['overall_status'] == 'stopped':
        print(f"Stop request detected for task {video_task_id}")

        # Cleanup temporary files
        cleanup_temp_directory()

        # Delete partial uploads from storage
        delete_folder_from_supabase(f"{user_id}/{group_id}/temp")

        # Update status
        supabase.table('video_tasks').update({
            'overall_status': 'stopped',
            'error_message': 'Stopped by user',
            'updated_at': datetime.now().isoformat()
        }).eq('id', video_task_id).execute()

        return True

    return False

# Check periodically during processing
for i in range(batch_start, batch_end + 1):
    if i % 5 == 0:  # Check every 5 iterations
        if handle_stop_request(supabase, video_task_id, user_id, group_id):
            return {'status': 'stopped'}

    # Process video...
```

### Monitoring & Debugging

#### Active Video Tasks Query

```sql
-- Get all active video tasks with progress breakdown
SELECT
  vt.id,
  vt.user_id,
  vt.story_title,
  vt.overall_status,
  vt.overall_progress,
  vt.story_status,
  vt.story_progress,
  vt.image_prompt_status,
  vt.image_prompt_progress,
  vt.image_generation_status,
  vt.image_generation_progress,
  vt.audio_status,
  vt.audio_progress,
  vt.individual_video_status,
  vt.individual_video_progress,
  vt.completed_individual_videos,
  vt.total_individual_videos,
  vt.video_creation_status,
  vt.video_creation_progress,
  vt.estimated_tokens,
  vt.used_tokens,
  vt.created_at,
  vt.updated_at,
  EXTRACT(EPOCH FROM (NOW() - vt.updated_at)) as seconds_since_update
FROM video_tasks vt
WHERE vt.overall_status IN ('pending', 'processing')
ORDER BY vt.created_at DESC;
```

#### Stalled Task Detection

```sql
-- Find video tasks that haven't updated in 20+ minutes (handled by check_stuck_video_tasks cron)
SELECT
  vt.id,
  vt.user_id,
  vt.story_title,
  vt.overall_status,
  vt.overall_progress,
  vt.current_batch_number,
  vt.individual_video_status,
  vt.completed_individual_videos,
  vt.total_individual_videos,
  vt.updated_at,
  EXTRACT(EPOCH FROM (NOW() - vt.updated_at)) / 60 as minutes_stalled
FROM video_tasks vt
WHERE vt.overall_status = 'processing'
  AND vt.updated_at < NOW() - INTERVAL '20 minutes'
ORDER BY vt.updated_at ASC;
```

#### Performance Analysis

```sql
-- Average completion time by phase
SELECT
  'story' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE story_status = 'completed'
  AND story_progress = 100

UNION ALL

SELECT
  'image_prompts' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE image_prompt_status = 'completed'
  AND image_prompt_progress = 100

UNION ALL

SELECT
  'images' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE image_generation_status = 'completed'
  AND image_generation_progress = 100

UNION ALL

SELECT
  'audio' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE audio_status = 'completed'
  AND audio_progress = 100

UNION ALL

SELECT
  'individual_videos' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE individual_video_status = 'completed'
  AND individual_video_progress = 100

UNION ALL

SELECT
  'final_video' as phase,
  AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) as avg_seconds,
  MIN(EXTRACT(EPOCH FROM (updated_at - created_at))) as min_seconds,
  MAX(EXTRACT(EPOCH FROM (updated_at - created_at))) as max_seconds
FROM video_tasks
WHERE video_creation_status = 'completed'
  AND video_creation_progress = 100;
```

#### Token Usage Analysis

```sql
-- Token usage by video task
SELECT
  vt.id,
  vt.story_title,
  vt.estimated_tokens,
  vt.used_tokens,
  vt.used_tokens - vt.estimated_tokens as token_difference,
  ROUND((vt.used_tokens::numeric / NULLIF(vt.estimated_tokens, 0)) * 100, 2) as accuracy_percent,
  vt.overall_status,
  vt.created_at,
  vt.completed_at
FROM video_tasks vt
WHERE vt.overall_status = 'completed'
ORDER BY vt.completed_at DESC
LIMIT 50;
```

#### Storage Usage Query

```sql
-- Video file storage by user
SELECT
  vt.user_id,
  p.email,
  COUNT(*) as total_videos,
  COUNT(*) FILTER (WHERE vt.final_video_url IS NOT NULL) as completed_videos,
  SUM(vt.estimated_tokens) as total_estimated_tokens,
  SUM(vt.used_tokens) as total_used_tokens
FROM video_tasks vt
JOIN profiles p ON p.id = vt.user_id
GROUP BY vt.user_id, p.email
ORDER BY total_used_tokens DESC;
```

#### Error Analysis

```sql
-- Most common error messages
SELECT
  LEFT(error_message, 100) as error_preview,
  COUNT(*) as occurrence_count,
  MAX(updated_at) as last_occurred
FROM video_tasks
WHERE overall_status = 'error'
  AND error_message IS NOT NULL
GROUP BY LEFT(error_message, 100)
ORDER BY occurrence_count DESC
LIMIT 20;
```

#### Video Task Success Rate

```sql
-- Success rate by time period
SELECT
  DATE_TRUNC('day', created_at) as date,
  COUNT(*) as total_tasks,
  COUNT(*) FILTER (WHERE overall_status = 'completed') as completed,
  COUNT(*) FILTER (WHERE overall_status = 'error') as errored,
  COUNT(*) FILTER (WHERE overall_status = 'stopped') as stopped,
  ROUND(
    (COUNT(*) FILTER (WHERE overall_status = 'completed')::numeric / COUNT(*)) * 100,
    2
  ) as success_rate_percent
FROM video_tasks
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY date DESC;
```

---

## Development Setup

### Prerequisites

- Node.js 18+
- Deno 1.37+
- Supabase CLI
- PostgreSQL (via Supabase)

### Environment Variables

```env
# Supabase
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key

# AI Models
DEEPSEEK_API_KEY=your-deepseek-key
ANTHROPIC_API_KEY=your-anthropic-key

# Deno Deploy
PARSE_FUNCTION_URL=https://storyscriptai-parse.deno.dev
```

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Run Supabase locally
supabase start

# Deploy edge functions
supabase functions deploy generate-story
supabase functions deploy process-story
# ... etc
```

### Testing

```bash
# Test outline generation
curl -X POST https://storyscriptai-outline.deno.dev \
  -H "Content-Type: application/json" \
  -d '{
    "description": "A test story",
    "word_count": 1000,
    "user_id": "uuid",
    "group_id": "uuid"
  }'

# Check task status
curl "https://your-supabase-url/rest/v1/story_tasks?group_id=eq.uuid" \
  -H "apikey: your-key"
```

---

## Troubleshooting

### Common Issues

**Issue**: Batch stuck in 'running' status

- **Cause**: Function timeout or API failure
- **Solution**: Automated cron jobs detect and reset stuck tasks within 40 minutes. See `check_stuck_*` functions in Error Handling section.

**Issue**: Word count mismatch

- **Cause**: AI generated too many/few words
- **Solution**: System validates output and triggers retry with adjusted target

**Issue**: Token quota exceeded

- **Cause**: User exceeded plan limits
- **Solution**: Frontend prevents generation start, prompts upgrade

**Issue**: Tab cleanup not working

- **Cause**: Active generation in progress
- **Solution**: System checks status and warns user before cleanup

---

## API Reference

### Frontend Utilities

#### `taskManager.ts`

```typescript
// Fetch tasks for a group
getTasks(userId: string, groupId: string, tab: number): Promise<StoryTask[]>

// Save new tasks
saveTasks(userId, groupId, tasks, title, outline): Promise<StoryTask[]>

// Update progress
updateTaskProgress(userId, groupId, progress, batchNumber): Promise<void>

// Stop generation
stopTasks(userId, groupId): Promise<void>

// Clear errors
clearTaskError(userId, groupId): Promise<void>
```

#### `generator.ts`

```typescript
// Parse outline into chapters/batches
parseOutline(outline, groupId, shouldStop, model): Promise<{chapters, batches}>

// Generate feedback
generateFeedback(outline, groupId, shouldStop, model): Promise<[feedback, tokens]>

// Compare stories
compareStories(doc1, doc2, userId, groupId, shouldStop, model, tab): Promise<[comparison, tokens]>

// Estimate costs
estimateStoryCredits(wordCount, includeCorrection, includeComparison, model): TokenEstimate
```

#### `tabManager.ts`

```typescript
// Create tab
createTab(userId, page, tabNumber, groupId, title, formInputs): Promise<boolean>

// Get tabs
getTabsForPage(userId, page): Promise<TabInfo[]>

// Update tab status
updateTabStatus(userId, page, tabNumber, status, groupId, title): Promise<boolean>

// Reset tab
resetTabToDefaults(userId, page, tabNumber): Promise<boolean>
```

---

_Document Version: 4.0_
_Last Updated: March 27, 2026_

---

## Text-to-Video (TTV) Generator

### Architecture Overview

The Text-to-Video (TTV) system converts story documents into AI-generated video clips by first generating cinematic video prompts from text segments, then synthesizing video clips from those prompts using various AI video models. The system supports both batch processing (entire documents) and single-clip generation. TTV is available as:

- A **standalone page** (`/text-to-video`) for direct TTV generation
- A **visual type option** within the Video Generator pipeline (Step 2: Visual Configuration → Text-to-Video tab)

The pipeline uses a two-phase batch processing model:

1. **Phase 1**: Generate TTV prompts from story text segments (AI writing models)
2. **Phase 2**: Generate video clips from prompts (AI video models)

### Database Schema

#### `TTV_prompt_context` Table

Stores full story context and settings for TTV prompt generation. One row per text part per generation run.

**Key Fields**:

```
id (uuid)                       - Primary key
group_id (uuid)                 - Groups all tasks for a single TTV generation
user_id (uuid)                  - Foreign key to users
full_story_text (text)          - Complete story text for this part
word_count (integer)            - Word count of text part
character_count (integer)       - Character count of text part
master_prompt_data (jsonb)      - Visual style, setting, atmosphere, characters
environment_only_mode (boolean) - Focus solely on settings without characters (default: false)
style_description (text)        - Visual style description
character_descriptions (jsonb)  - Extracted character profiles
tab (integer)                   - Tab number (default: 1)
part_number (integer)           - Part number for multi-part stories (default: 1)
video_model (varchar)           - Selected video model
video_duration (numeric)        - Duration per video clip in seconds
total_videos (integer)          - Total number of video clips to generate
audio_clip (boolean)            - Whether to embed audio in video clips (default: false)
custom_chars_in_story (boolean) - Whether custom characters were found in story text (default: false)
use_character_descriptions (boolean) - Whether to use character consistency (default: true)
image_model (varchar)           - Image model (used for related image generation)
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### `TTV_prompt_tasks` Table

Tracks prompt generation tasks. Each row represents a batch of text segments to convert to video prompts.

**Key Fields**:

```
id (uuid)                       - Primary key
user_id (uuid)                  - Foreign key to users
group_id (uuid)                 - Groups all tasks for a single generation
story_title (text)              - Story title
description (text)              - Story description
batch (jsonb)                   - Array of text segments [{text, index}]
text_part (text)                - Raw text content for this batch
batch_output (text)             - JSON string of generated prompts [{text, prompt}]
total_batches (integer)         - Total number of prompt batches
batch_number (integer)          - Current batch number (1-indexed)
total_prompts (integer)         - Total number of prompts across all batches
total_videos (integer)          - Total video clips to generate
progress (integer)              - Completion percentage (0-100)
status (varchar)                - 'pending', 'queued', 'running', 'completed', 'completed_final', 'error'
error (text)                    - Error message if failed
settings (jsonb)                - Generation settings (style, characters, video_model, video_duration)
variant (integer)               - Story variant number
doc_id (uuid)                   - Reference to source story document
file_path (text)                - Path to generated prompts document
input_tokens (integer)          - AI tokens consumed (input, default: 0)
output_tokens (integer)         - AI tokens generated (output, default: 0)
version (integer)               - 12 = original, 13 = corrected (default: 1)
model (text)                    - AI writing model ('deepseek', 'sonnet', 'opus')
language (text)                 - Generation language (default: 'english')
tab (integer)                   - Tab number (default: 1)
video_model (varchar)           - Selected video model
video_duration (numeric)        - Duration per clip in seconds
audio_clip (boolean)            - Audio clip flag (default: false)
is_corrected (boolean)          - Whether using corrected story (default: false)
stop_requested (boolean)        - User requested cancellation (default: false)
check_stuck (boolean)           - Stuck task detection flag (default: false)
token_updated (boolean)         - Whether tokens have been deducted (default: false)
outline (text)                  - Outline text (batch_number=0)
feedback (text)                 - Feedback text
ttv_prompt_document_id (uuid)   - Reference to compiled prompts document
video_process (boolean)         - Whether this is part of video pipeline (default: false)
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### `TTV_tasks` Table

Tracks individual video clip generation tasks. Each row represents one video clip to generate.

**Key Fields**:

```
id (uuid)                       - Primary key
user_id (uuid)                  - Foreign key to users
group_id (uuid)                 - Groups all tasks for a single generation
doc_id (uuid)                   - Reference to source document
story_title (text)              - Story title
description (text)              - Story description
file_path (text)                - Path to generated video file
text_part (text)                - Text segment for this clip
batch (jsonb)                   - Array with single prompt item [{text, prompt, index}]
batch_output (text)             - Output metadata
total_batches (integer)         - Total number of video clips
batch_number (integer)          - Current clip number (1-indexed)
total_prompts (integer)         - Total prompts count
progress (integer)              - Completion percentage (0-100)
status (varchar)                - 'pending', 'queued', 'running', 'completed', 'completed_final', 'error'
error (text)                    - Error message if failed
settings (jsonb)                - Generation settings including high_res flag
variant (integer)               - Story variant number
is_corrected (boolean)          - Whether using corrected story (default: false)
stop_requested (boolean)        - User requested cancellation (default: false)
tokens (integer)                - Tokens consumed for this clip (default: 0)
token_updated (boolean)         - Whether tokens have been deducted (default: false)
version (integer)               - 14 = original, 15 = corrected
folder_timestamp (text)         - Timestamp folder name for storage
video_model (varchar)           - Video model used
video_duration (numeric)        - Duration of generated clip in seconds
polling_url (text)              - URL for polling video generation status
polling_id (text)               - Job ID for polling
poll_attempts (integer)         - Number of poll attempts made (default: 0)
video_url (text)                - Final video URL after generation
language (text)                 - Language (default: 'english')
tab (integer)                   - Tab number (default: 1)
ttv_folder_document_id (uuid)   - Reference to final TTV folder document
check_stuck (boolean)           - Stuck task detection flag (default: false)
redo_status (text)              - 'redoing' during redo, null otherwise
redo_started_at (timestamptz)   - When redo was initiated
audio_clip (boolean)            - Audio clip flag (default: false)
single_ttv (boolean)            - Whether this is a single-clip generation (default: false)
video_process (boolean)         - Whether part of video pipeline (default: false)
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### Updated `video_tasks` Table (TTV-related columns)

The existing `video_tasks` table has been updated with TTV tracking fields:

```
visual_type (varchar)           - 'image', 'ttv', or 'itv' (default: 'image')
process_ttv (boolean)           - Whether to process TTV in pipeline (default: false)
video_model (varchar)           - TTV video model selection
video_duration (numeric)        - TTV clip duration in seconds
audio_clip (boolean)            - TTV audio clip flag (default: false)
ttv_prompt_status (text)        - TTV prompt generation status (default: 'pending')
ttv_prompt_progress (integer)   - TTV prompt generation progress 0-100 (default: 0)
ttv_status (text)               - TTV video generation status (default: 'pending')
ttv_progress (integer)          - TTV video generation progress 0-100 (default: 0)
ttv_prompt_document_id (uuid)   - Reference to compiled TTV prompts document
ttv_folder_document_id (uuid)   - Reference to final TTV video folder document
```

#### Updated `tabs` Table (TTV-related columns)

```
visual_type (varchar)           - 'image', 'ttv', or 'itv' (default: 'image')
process_ttv (boolean)           - Whether TTV is enabled (default: false)
video_model (varchar)           - Selected TTV video model
video_duration (numeric)        - TTV clip duration
audio_clip (boolean)            - TTV audio clip flag (default: false)
```

#### Updated `story_documents` Table (TTV-related columns)

```
audio_clip (boolean)            - Whether audio clips were embedded (default: false)
pauses (boolean)                - Whether pauses were used (default: false)
```

**Version Numbering for TTV**:

- Version 12: TTV prompt document (original story)
- Version 13: TTV prompt document (corrected story)
- Version 14: TTV video folder (original story)
- Version 15: TTV video folder (corrected story)

### Frontend Components

#### `TextToVideoGeneratorContainer.tsx`

**Purpose**: Wrapper component managing tab state and TextToVideoGenerator lifecycle.

**Key Responsibilities**:

- Checks enterprise user status
- Manages multiple TTV tab configurations
- Forces TextToVideoGenerator remount on tab changes for complete isolation
- Handles tab creation, switching, and cleanup

#### `TextToVideoGenerator.tsx`

**Purpose**: Main TTV generation interface (~3,000 lines) with document selection, model configuration, and progress tracking.

**Key Features**:

- **Two Generation Modes**:
  - **Document mode**: Convert entire story document to video sequence
  - **Single prompt mode**: Generate single video clip from individual prompt (via `single-TTV`)

- **9 Video Models** across 6 tiers:

  | Tier     | Model                 | Resolution         | Tokens/sec              | Duration     |
  | -------- | --------------------- | ------------------ | ----------------------- | ------------ |
  | Entry    | Wan 2.2               | 480p               | 1,500                   | Fixed 5s     |
  | Standard | Seedance 1.0 Pro Fast | 720p               | 13,200                  | 5s/10s       |
  | Standard | LTX 2.3 Fast          | 1080p              | 24,000                  | 5s/9s        |
  | Plus     | Grok                  | Flexible           | 30,000 (45K high-res)   | 5-17s slider |
  | Plus     | Seedance 1.5 Pro      | 1080p              | 34,800 (69.6K w/audio)  | 5s/10s       |
  | Pro      | Veo 3.1 Fast          | 1080p              | 60,000 (90K w/audio)    | 4-8s options |
  | Pro      | LTX 2.3 Pro           | 1440p              | 72,000                  | 5s/9s        |
  | Elite    | Veo 3.1               | 1080p              | 120,000 (240K w/audio)  | 4-8s options |
  | Ultimate | Sora 2 Pro            | 720p (4K high-res) | 180,000 (300K high-res) | 5-20s slider |

- **16 Visual Styles**: Classical Oil Painting, Anime/Manga, Comic Book, Pixel Art, Photorealistic, Watercolor, Art Deco, Cyberpunk Neon, Studio Ghibli, Steampunk Victorian, Minimalist Flat, Claymation, Film Noir, Retro Sci-Fi, Gothic Dark Fantasy, Pop Art

- **Custom Style Support**: Textarea input (1,200 character limit) for custom visual descriptions

- **Character Consistency**: Optional AI-powered character extraction and enhancement with name-matching from story text

- **Audio Clip Embedding**: Select models support embedded audio generation (2× token cost)

- **High-Resolution Toggle**: Available for Grok (720p → 4K) and Sora 2 Pro (720p → 1792×1024)

- **Token Estimation**: Real-time token cost calculation based on model, duration, clip count, and audio/high-res multipliers

- **Progress Tracking**: Real-time polling with batch-level status, estimated time remaining, and resume detection on page reload

- **ZIP Download**: Streaming download of all generated clips with progress indicator

- **Redo Individual Clips**: Regenerate specific clips without rerunning entire pipeline

**State Flow**:

1. User selects story document or enters single prompt
2. Configures video model, duration, visual style, characters
3. Token estimation displayed with storage requirements
4. Clicks "Generate TTV"
5. Phase 1: TTV prompts generated from text segments (polling every 6s)
6. Phase 2: Video clips generated from prompts (polling every 10s)
7. On completion: ZIP download available, individual clip preview/redo

#### `VideoModelSelector.tsx`

**Purpose**: Model selection grid component for TTV video models.

**Features**:

- 9 models displayed in responsive grid layout
- Each card shows: resolution, token cost/second, duration options, example video preview
- Hover/click expansion for duration configuration and style selection
- 16 visual styles in 2-column scrollable grid
- Custom style textarea (1,200 char limit)
- Recommended model highlighted (Grok for best value)
- Duration controls: fixed values, dropdown options, or continuous slider depending on model

#### `VisualConfiguration.tsx`

**Purpose**: Visual type orchestration component (~4,000 lines) within the Video Generator pipeline (Step 2).

**Three Visual Type Tabs**:

1. **Image Generation**: Static images with pan/zoom animation
2. **Text-to-Video**: Direct video synthesis from text (highest quality, most expensive)
3. **Image-to-Video**: Image generation → video animation (balanced cost/quality)

**Source Sub-Options** (per visual type):

- **Generate**: Create new visuals via AI
- **Folder**: Use existing generated assets from a previous run
- **Upload**: Loop a video file throughout the duration

**TTV Section**:

- Video model selection (VideoModelSelector)
- Style grid with 16 options + custom
- Duration configuration
- Character consistency toggle with AI enhancement
- Audio clip toggle

### Backend Functions

#### Deno Deploy Functions

##### `setup-ttv-prompts.ts`

**Purpose**: Initializes TTV job setup from user request. Validates tokens, extracts characters, segments text, and creates prompt generation tasks.

**Process**:

1. Validates request: user_id, group_id, file_path, story_title, video_model, clip_duration
2. Estimates tokens for Phase 1 (prompts) + Phase 2 (video generation)
3. Checks user token balance (unless part of video pipeline where tokens are pre-validated)
4. **Character Extraction** (optional):
   - If `useCharacterDescriptions=true`: Calls DeepSeek to extract 3-5 main characters with visual descriptions
   - Stores character profiles in settings
5. Calculates video clip count: `ceil(totalAudioDuration / clip_duration)`
6. Normalizes text: strips SSML breaks, fixes encoding (smart quotes, em-dashes)
7. Cleans chapter markers and headers
8. Splits large text into parts (max 56,000 chars per part)
9. Segments text into exact N segments using `forceExactSegments()` at sentence/paragraph boundaries
10. **Stores TTV_prompt_context**: One row per text part with video_model, video_duration, audio_clip, style, characters
11. **Creates job_data row**: Full job config for process-ttv-task.ts
12. Triggers `process-ttv-task.ts` to create batch tasks

**Text Segmentation Logic**:

```typescript
interface TTVSegment {
  text: string; // Text content for this segment
  start: number; // Start position in original text
  video_duration: number; // Duration for resulting video clip
}

// Constants
const BATCH_SIZE = 2; // Segments per batch
const MAX_TEXT_PART_CHARS = 56000; // Max chars per text_part
const MIN_TEXT_PART_LENGTH = 50; // Minimum segment length
```

##### `process-ttv-task.ts`

**Purpose**: Creates TTV_prompt_tasks batch rows from job data prepared by setup-ttv-prompts.

**Process**:

1. Fetches job data from `job_data` table by jobId
2. Validates: group_id, file_path, story_title, video_model, clip_duration, total_videos
3. Prevents duplicate creation: checks for existing tasks created in last 5 minutes
4. Normalizes segments (supports both segmentsByPart and flat segments arrays)
5. Partitions segments by text_part key
6. Creates batches of 2 segments each
7. Inserts TTV_prompt_tasks rows (in 20-row chunks with 200ms delays)
   - First task: `status='queued'`, rest: `status='pending'`
   - Version 12 (original) or 13 (corrected)
8. Fires `trigger-next-TTV-prompt` to start processing

**Key Functions**:

```typescript
calculateWordCount(text); // Count words in segment
normalizeText(text); // Fix encoding issues
cleanTextForTTV(text); // Remove chapter headers
findTTVSplitPoint(text, pos); // Find ideal boundary (sentence > paragraph > word)
forceExactSegments(text, n); // Split into exact N segments
splitTextIfLarge(text); // Break documents > 56KB into parts
```

#### Supabase Edge Functions

##### `generate-TTV-prompt/`

**Purpose**: Generates cinematic video prompts for each text segment using LLMs.

**Input**:

```json
{
  "batch_segments": [{ "text": "story segment...", "index": 0 }],
  "text_part": "full text for context",
  "settings": {
    "style": "...",
    "useCharacterDescriptions": true,
    "characters": {}
  },
  "model": "deepseek",
  "language": "english",
  "task_id": "uuid",
  "group_id": "uuid",
  "tab": 1,
  "variant": 1,
  "audio_clip": false
}
```

**Process**:

1. Validates input segments (non-empty text, valid durations)
2. Normalizes segment text (strips SSML tags, fixes encoding)
3. Fetches TTV_prompt_context by group_id, part_number, tab
4. Fetches completed prompts from previous batches (limit 5 for consistency)
5. Builds system prompt with:
   - Full story context from TTV_prompt_context
   - Visual style guidelines from master_prompt_data
   - Character descriptions filtered by mentions
   - Environment-only mode support
   - Audio atmosphere description if audio_clip=true
   - Language-specific instructions (English, German, Spanish, French)
6. Calls LLM (streaming for DeepSeek, direct for Anthropic Claude)
7. Parses JSON response with retry logic (up to 2 retries on count mismatch)
8. Appends style block + selective character descriptions to each prompt
9. Returns `{results: [{text, prompt}], input_tokens, output_tokens, model}`

**Model Support**:

- DeepSeek: `TOKEN_PER_WORD = 1.33`, streaming via OpenAI-compatible API
- Sonnet: Direct Anthropic API, `11x` token multiplier
- Opus: Direct Anthropic API, `19x` token multiplier

##### `process-TTV-prompt/`

**Purpose**: Orchestrates TTV prompt generation batches.

**Process**:

1. Validates inputs (UUID format, batch_number > 0)
2. Resets stuck tasks (status='running' for >5 min → reset to 'queued')
3. Fetches TTV_prompt_task by (group_id, user_id, batch_number, tab, variant)
4. If already completed → trigger next batch
5. Validates batch segments (non-empty, valid durations)
6. Calls `generate-TTV-prompt` with retry logic (6 attempts, exponential backoff)
7. Stores results as JSON in batch_output
8. Updates task: status='completed', progress=100, token counts
9. Updates video_tasks progress (if part of video pipeline)
10. On last batch: calls `compileFinalTTVDocument()` to create compiled prompts document
11. Otherwise: triggers `trigger-next-TTV-prompt` for next batch
12. Returns 202 if processing exceeds 140s (background task continues)

**compileFinalTTVDocument** (within process-TTV-prompt):

1. Aggregates all batch_output into single JSON array
2. Uploads compiled prompts to Supabase Storage
3. Creates `story_documents` record (version 12/13)
4. Calls `setup-TTV-tasks` to create video generation tasks

##### `setup-TTV-tasks/`

**Purpose**: Transforms compiled TTV prompts JSON document into individual TTV_tasks rows (one per video clip).

**Process**:

1. Validates all required UUIDs and fields
2. Checks variant collision: increments variant if existing tasks found
3. Fetches source document metadata (is_corrected, language)
4. Determines output version: 14 (original) or 15 (corrected)
5. Checks if part of video pipeline (video_tasks with `visual_type='ttv'`)
6. Downloads & parses TTV prompts JSON from storage
7. Creates one TTV_task per prompt:
   - `batch`: `[{text, prompt, index}]`
   - First task: `status='queued'`, rest: `status='pending'`
   - Includes video_model, video_duration, audio_clip, high_res settings
8. Inserts in chunks of 20 with 200ms delays
9. Fires `trigger-next-TTV` to start video generation

**Supported Video Models**:

```typescript
SUPPORTED_VIDEO_MODELS = [
  "wan22",
  "seedance_pro_fast",
  "ltx23_fast",
  "grok",
  "grok_highres",
  "seedance15_pro",
  "ltx23_pro",
  "veo31fast",
  "veo31",
  "sora2pro",
  "sora2pro_highres",
];
```

##### `generate-TTV/`

**Purpose**: Unified API gateway routing video generation across 9+ models. Stateless — handles only submission and polling.

**Two Modes**:

- **Submit**: Initiates video generation → returns `{status, polling_id, polling_url}`
- **Poll**: Checks job status → returns `{status: 'pending'|'completed'|'failed', video_url?, error?}`

**Model API Routing**:

| API Type      | Models             | Endpoint                                           |
| ------------- | ------------------ | -------------------------------------------------- |
| ModelsLab v6  | Wan 2.2            | `modelslab.com/api/v6/video/text2video_ultra`      |
| fal.ai Client | Seedance, LTX-2.3  | `queue.fal.run/[model_id]`                         |
| xAI Grok      | Grok               | `api.x.ai/v1/videos/generations`                   |
| fal.ai Veo    | Veo 3.1            | `queue.fal.run/[model_id]`                         |
| fal.ai Wan    | Wan 2.2 (fallback) | `queue.fal.run/fal-ai/wan/v2.2/1.3b/text-to-video` |
| OpenAI Sora   | Sora 2 Pro         | OpenAI SDK `v1/videos/generations`                 |

**Negative Prompt** (ModelsLab):

```
"blurry, low quality, distorted, extra limbs, missing limbs, broken fingers, deformed,
glitch, artifacts, unrealistic, low resolution, bad anatomy, duplicate, cropped, watermark,
text, logo, jpeg artifacts, noisy, oversaturated, underexposed, overexposed, flicker,
unstable motion, motion blur, stretched, mutated, out of frame, bad proportions"
```

**Content Moderation**: Grok returns `{error: 'content_moderation'}` which triggers `empty-redo-TTV`

##### `process-TTV/`

**Purpose**: Main TTV video generation orchestrator. Manages job submission, polling chains, video download/upload, and final document compilation.

**Key Constants**:

```typescript
INITIAL_POLL_DELAY_MS = {
  wan22: 360000,           // 6 min (slow model)
  seedance/ltx/grok/veo: 90000,  // 90s
  sora2pro: 360000,        // 6 min
  sora2pro_highres: 290000 // fires phase 2 self-call
}

MAX_IN_PROCESS_POLL_ATTEMPTS = 3  // polls per invocation
MAX_TOTAL_POLL_ATTEMPTS = 5       // max across self-call chain
MAX_WAIT_MS = 380000              // stay under 400s edge function budget

LONG_POLL_MODELS = ['wan22', 'sora2pro', 'sora2pro_highres']  // one poll per invocation
```

**Process**:

1. Fetches queued TTV_task from database
2. Extracts prompt from `task.batch[0].prompt`
3. Calls `generate-TTV` (submit mode) → gets polling_id/polling_url
4. Returns HTTP 200 immediately
5. **In EdgeRuntime.waitUntil** (background):
   - Sleeps `INITIAL_POLL_DELAY_MS` for model
   - **Long-poll models** (Wan, Sora): One poll per invocation, then fires self-call if pending
     - Wan 2.2 fallback: After 1 pending poll → switches to `wan22_fal` (fal.ai) automatically
   - **Short-poll models**: In-process loop (3 polls × 90s = 270s < 400s budget)
   - On completion: downloads video, uploads to storage, triggers next batch
   - On content moderation failure: delegates to `empty-redo-TTV`

**Sora High-Res Two-Phase Polling**:

```
Phase 1 (290s): Initial submit + sleep → fire phase 2 self-call
Phase 2 (180s): Sleep + 4 tight poll attempts at 30s intervals
```

**completeTask Flow**:

1. Downloads video bytes (Sora via OpenAI SDK with Bearer token, others via fetch)
2. Strips audio if model always generates it (Grok, Sora) and `audio_clip=false`
3. Uploads to `documents/{userId}/{groupId}/TTV-{sanitized}_{timestamp}/{batchNumber}.mp4`
4. Calculates tokens: `duration × tokensPerSecond`
5. Updates TTV_tasks: status='completed', video_url, tokens, token_updated=true
6. If last batch → `compileFinalTTVDocument`
7. Otherwise → `trigger-next-TTV`

**compileFinalTTVDocument**:

1. Creates `story_documents` record (title: "TTV Outputs: {title}", version 14/15)
2. Marks all TTV_tasks as `completed_final`
3. Sets `tabs.status='complete'`
4. **Bridges to video pipeline** (if `video_tasks` exists with `visual_type='ttv'`):
   - Updates all TTV statuses to completed
   - Checks if ALL pipeline steps done (story, images/TTV, audio)
   - If complete → calls `setup-video-tasks` to start final video assembly

##### `trigger-next-TTV/`

**Purpose**: Queues the next pending TTV_task and fires `process-TTV`.

**Process**:

1. Fetches all TTV_tasks for (group_id, user_id, tab, variant)
2. Checks if previous batch failed → re-queues it for retry
3. If all batches completed → returns
4. Finds next queued/pending/error task
5. Sets status='queued', fires `process-TTV` (fire-and-forget)

##### `trigger-next-TTV-prompt/`

**Purpose**: Queues next TTV prompt batch and fires `process-TTV-prompt`. Mirrors trigger-next-TTV but for the prompt generation pipeline.

##### `redo-TTV/`

**Purpose**: Regenerates a single video clip. Supports user-initiated clip retry with self-call polling chain.

**Process** (Initial):

1. Authenticates via Bearer token (JWT)
2. Fetches TTV_task by group_id and batch_number
3. Validates token balance against user_plans
4. Marks task: `redo_status='redoing'`, `redo_started_at=now`
5. Returns 202 immediately
6. In background: submits job, enters poll loop (self-call chain for long-poll models)

**Process** (Poll Mode — self-call):

1. Fetches fresh task state
2. If redo_status already null → skip (already done by another invoke)
3. Polls via generate-TTV
4. On completion: downloads, uploads (upserts), charges tokens
5. On pending: fires another self-call if attempts < MAX_TOTAL_POLL_ATTEMPTS (60)

**Token Deduction**: Handled via database trigger `ttv_tasks_tokens_update` on TTV_tasks update

##### `single-TTV/`

**Purpose**: Generates a single video clip from a user-supplied prompt (standalone, not part of batch pipeline).

**Process**:

1. Authenticates via Bearer token
2. Validates video_model and video_duration (1-60s)
3. Checks token balance
4. Inserts TTV_tasks row with `single_ttv=true`, `batch_number=1`, `total_batches=1`
5. Returns 202 immediately
6. In background: submits to generate-TTV, enters poll loop
7. On completion: downloads, optionally strips audio, uploads, marks `completed_final`

**Content Moderation Recovery**:

- If poll returns `error='content_moderation'` → calls `empty-redo-TTV`
- `empty-redo-TTV` rewrites prompt with DeepSeek safety filter, resubmits

**Always-Audio Models** (Grok, Sora): These models always generate audio. If `audio_clip=false`, audio is stripped from the MP4 after download using a pure-JS MP4 parser.

##### `empty-redo-TTV/`

**Purpose**: Automatic content moderation recovery. Rewrites rejected prompts and resubmits.

**Process**:

1. Fetches TTV_task by task_id
2. Extracts original prompt from batch[0].prompt
3. Calls DeepSeek streaming with language-specific safety system prompt:
   - Transforms violent → tense, sexual → tasteful
   - Preserves cinematic language (camera, lighting, motion, mood)
4. Updates batch with safe prompt
5. **If single_ttv**: Submits fresh job via generate-TTV, fires single-TTV poll mode
6. **If batch**: Sets status='queued', fires process-TTV

### Token Costs

#### TTV Token Calculation

```typescript
TTV_TOKENS_PER_SECOND = {
  wan22: 1500,
  seedance_pro_fast: 13200,
  ltx23_fast: 24000,
  grok: 30000,           // 45,000 with high-res
  seedance15_pro: 34800,
  veo31fast: 60000,
  ltx23_pro: 72000,
  veo31: 120000,
  sora2pro: 180000,      // 300,000 with high-res
}

// Audio-enabled models (2× cost):
TTV_AUDIO_TOKENS_PER_SECOND = {
  seedance15_pro: 69600,
  veo31fast: 90000,
  veo31: 240000,
}

// Token formula:
prompt_tokens = 800 × num_clips × model_multiplier  // (deepseek=1, sonnet=11, opus=19)
video_tokens = tokens_per_second × duration × num_clips
total_ttv_tokens = prompt_tokens + video_tokens
```

### User Workflows

#### Standalone TTV Generation

1. Navigate to Text-to-Video page
2. Select source document from document browser
3. Choose video model and configure duration
4. Select visual style (16 presets or custom)
5. Optionally enable character consistency and/or audio clips
6. Click "Generate TTV"
7. Phase 1: TTV prompts generated (progress polled every 6s)
8. Phase 2: Video clips generated (progress polled every 10s)
9. Download individual clips or entire ZIP archive
10. Optionally redo individual clips

#### TTV in Video Pipeline

1. In Video Generator, Step 2 (Visual Configuration) → select "Text-to-Video" tab
2. Configure model, style, duration under TTV generator section
3. Continue to Step 3 (Audio) and Step 4 (Video Configuration)
4. Video pipeline executes: Story → TTV Prompts → TTV Videos → Audio → Final Video Assembly
5. TTV completion bridges to `setup-video-tasks` for final MP4 assembly

### Error Handling & Recovery

- **Stuck Task Recovery**: Cron job `check_stuck_TTV_tasks()` runs every 20 minutes with two-phase detection
- **Content Moderation**: Automatic prompt rewriting via `empty-redo-TTV` with DeepSeek safety filter
- **Wan 2.2 Fallback**: After 1 pending ModelsLab poll → switches to fal.ai Wan 2.2 for faster processing
- **Self-Call Polling**: Long-running jobs chain via self-calls to stay under 400s edge function limit
- **Retry Logic**: 6 exponential backoff attempts for API calls; 429/5xx errors trigger retry

### Pipeline Flow

```
Frontend Request
    ↓
setup-ttv-prompts.ts (Deno Deploy)
    ├→ Validate tokens, extract characters
    ├→ Segment text, store TTV_prompt_context
    └→ Create job_data
        ↓
process-ttv-task.ts (Deno Deploy)
    ├→ Create TTV_prompt_tasks rows
    └→ Fire trigger-next-TTV-prompt
        ↓
trigger-next-TTV-prompt → process-TTV-prompt → generate-TTV-prompt
    ↓ (batch loop until all prompt batches done)
compileFinalTTVDocument (in process-TTV-prompt)
    ├→ Upload compiled prompts JSON
    ├→ Create story_documents (v12/13)
    └→ Fire setup-TTV-tasks
        ↓
setup-TTV-tasks
    ├→ Parse prompts, create one TTV_task per clip
    └→ Fire trigger-next-TTV
        ↓
trigger-next-TTV → process-TTV → generate-TTV
    ↓ (poll loop per clip, with self-call chains)
    ├→ Content moderation failure → empty-redo-TTV → resubmit
    ├→ Download video → Upload to storage
    └→ On last clip:
        compileFinalTTVDocument (in process-TTV)
        ├→ Create story_documents (v14/15)
        ├→ Mark tabs.status='complete'
        └→ Bridge to video_tasks → setup-video-tasks (if pipeline)
```

---

## Image-to-Video (ITV) Generator

### Architecture Overview

The Image-to-Video (ITV) system is a 4-phase pipeline that generates animated video clips from story documents. Unlike TTV which goes directly from text to video, ITV first generates keyframe images and then animates them into video clips. This approach provides:

- Better visual control (keyframe images can be previewed before animation)
- Lower cost per clip compared to pure TTV for most models
- Higher quality motion (image → video models have richer motion fidelity)
- Granular redo options (regenerate image only, video only, or both)

ITV is available as:

- A **standalone page** (`/image-to-video`) for direct ITV generation
- A **visual type option** within the Video Generator pipeline (Step 2: Visual Configuration → Image-to-Video tab)

The 4-phase pipeline:

1. **Phase 1**: Generate keyframe image prompts from story text segments (AI writing models)
2. **Phase 2**: Generate keyframe images from prompts (AI image models)
3. **Phase 3**: Generate motion/animation prompts for each keyframe (AI writing models)
4. **Phase 4**: Animate keyframe images into video clips (AI video models)

Phases 2 and 3 run **concurrently** — images are generated while motion prompts are being written.

### Database Schema

#### `ITV_prompt_context` Table

Stores full story context and settings for ITV prompt generation. One row per text part per generation run.

**Key Fields**:

```
id (uuid)                       - Primary key
group_id (uuid)                 - Groups all tasks for a single ITV generation
user_id (uuid)                  - Foreign key to users
full_story_text (text)          - Complete story text for this part
word_count (integer)            - Word count of text part
character_count (integer)       - Character count of text part
master_prompt_data (jsonb)      - Visual style, setting, atmosphere, characters
environment_only_mode (boolean) - Focus solely on settings without characters (default: false)
style_description (text)        - Visual style description
character_descriptions (jsonb)  - Extracted character profiles
tab (integer)                   - Tab number (default: 1)
part_number (integer)           - Part number for multi-part stories (default: 1)
video_model (varchar)           - Selected ITV video model
video_duration (numeric)        - Duration per video clip in seconds
total_videos (integer)          - Total number of video clips to generate
audio_clip (boolean)            - Whether to embed audio in video clips (default: false)
custom_chars_in_story (boolean) - Whether custom characters were found in story text (default: false)
itv (boolean)                   - false for Phase 1 context, true for Phase 2 (default: false)
audio_duration (numeric)        - Total audio duration
phase1_document_path (text)     - Path to Phase 1 compiled prompts document
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### `ITV_prompt_tasks` Table

Tracks both Phase 1 (image prompt) and Phase 2 (motion prompt) generation tasks. Differentiated by the `itv` boolean flag.

**Key Fields**:

```
id (uuid)                       - Primary key
user_id (uuid)                  - Foreign key to users
group_id (uuid)                 - Groups all tasks for a single generation
story_title (text)              - Story title
description (text)              - Story description
batch (jsonb)                   - Array of segments [{text, index}] (Phase 1) or [{text, image_prompt, index}] (Phase 2)
text_part (text)                - Raw text content for context
batch_output (text)             - JSON string of generated prompts
total_batches (integer)         - Total number of batches
batch_number (integer)          - Current batch number (1-indexed)
total_prompts (integer)         - Total prompts count
total_videos (integer)          - Total video clips to generate
progress (integer)              - Completion percentage (0-100)
status (varchar)                - 'pending', 'queued', 'running', 'completed', 'completed_final', 'error'
error (text)                    - Error message if failed
settings (jsonb)                - Generation settings
variant (integer)               - Story variant
doc_id (uuid)                   - Reference to source document
file_path (text)                - Path to generated prompts document
input_tokens (integer)          - AI tokens consumed (input, default: 0)
output_tokens (integer)         - AI tokens generated (output, default: 0)
version (integer)               - Phase 1: 16/17, Phase 2: 20/21
model (text)                    - AI writing model ('deepseek', 'sonnet', 'opus')
language (text)                 - Generation language (default: 'english')
tab (integer)                   - Tab number (default: 1)
video_model (varchar)           - Selected ITV video model
video_duration (numeric)        - Duration per clip in seconds
audio_clip (boolean)            - Audio clip flag (default: false)
itv (boolean)                   - false = Phase 1 (image prompts), true = Phase 2 (motion prompts)
is_corrected (boolean)          - Whether using corrected story (default: false)
stop_requested (boolean)        - User requested cancellation (default: false)
check_stuck (boolean)           - Stuck task detection flag (default: false)
token_updated (boolean)         - Whether tokens have been deducted (default: false)
outline (text)                  - Outline text
feedback (text)                 - Feedback text
itv_image_prompt_document_id (uuid) - Reference to Phase 1 compiled image prompts document
itv_video_prompt_document_id (uuid) - Reference to Phase 2 compiled motion prompts document
image_model (varchar)           - Image model for keyframe generation
video_process (boolean)         - Whether part of video pipeline (default: false)
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### `ITV_tasks` Table

Tracks individual video clip generation tasks. Each row represents one keyframe image → animated video clip.

**Key Fields**:

```
id (uuid)                       - Primary key
user_id (uuid)                  - Foreign key to users
group_id (uuid)                 - Groups all tasks for a single generation
doc_id (uuid)                   - Reference to source document
story_title (text)              - Story title
description (text)              - Story description
file_path (text)                - Path to generated video file
text_part (text)                - Text segment for this clip
batch (jsonb)                   - [{text, prompt, image_url, image_number, index}]
batch_output (text)             - Output metadata
total_batches (integer)         - Total number of video clips
batch_number (integer)          - Current clip number (1-indexed)
total_prompts (integer)         - Total prompts count
progress (integer)              - Completion percentage (0-100)
status (varchar)                - 'pending', 'queued', 'running', 'completed', 'completed_final', 'error'
error (text)                    - Error message if failed
settings (jsonb)                - Generation settings {}
variant (integer)               - Story variant
is_corrected (boolean)          - Whether using corrected story (default: false)
stop_requested (boolean)        - User requested cancellation (default: false)
tokens (integer)                - Tokens consumed for this clip (default: 0)
token_updated (boolean)         - Whether tokens have been deducted (default: false)
version (integer)               - 22 = original, 23 = corrected
folder_timestamp (text)         - Timestamp folder name for storage
video_model (varchar)           - ITV video model used
video_duration (numeric)        - Duration of clip in seconds
audio_clip (boolean)            - Audio clip flag (default: false)
image_url (text)                - URL of keyframe image used as input
image_number (integer)          - Image number in sequence
polling_url (text)              - URL for polling video generation status
polling_id (text)               - Job ID for polling
poll_attempts (integer)         - Number of poll attempts (default: 0)
video_url (text)                - Final video URL after generation
language (text)                 - Language (default: 'english')
tab (integer)                   - Tab number (default: 1)
single_itv (boolean)            - Whether this is a single-clip generation (default: false)
check_stuck (boolean)           - Stuck task detection flag (default: false)
redo_status (text)              - 'redoing' during redo, null otherwise
redo_started_at (timestamptz)   - When redo was initiated
itv_video_folder_document_id (uuid) - Reference to final ITV video folder document
image_model (varchar)           - Image model used for keyframe
video_process (boolean)         - Whether part of video pipeline (default: false)
created_at (timestamptz)        - Creation timestamp
updated_at (timestamptz)        - Last update timestamp
```

#### Updated `image_tasks` Table (ITV-related columns)

```
itv (boolean)                   - Whether this image task is for ITV keyframes (default: false)
image_folder_document_id (uuid) - Reference to compiled images folder document
```

When `itv=true`, image_tasks generates keyframe images that feed into the ITV pipeline (Phase 2).

#### Updated `video_tasks` Table (ITV-related columns)

```
visual_type (varchar)           - 'image', 'ttv', or 'itv' (default: 'image')
process_itv (boolean)           - Whether to process ITV in pipeline (default: false)
itv_model (varchar)             - ITV video model selection (default: 'wan22')
itv_duration (numeric)          - ITV clip duration in seconds (default: 6)
itv_audio_clip (boolean)        - ITV audio clip flag (default: false — note: uses column name audio_clip in some contexts)
itv_prompt_status (text)        - ITV prompt generation status (default: 'pending')
itv_prompt_progress (integer)   - ITV prompt generation progress 0-100 (default: 0)
itv_status (text)               - ITV video generation status (default: 'pending')
itv_progress (integer)          - ITV video generation progress 0-100 (default: 0)
itv_image_prompt_document_id (uuid) - Reference to Phase 1 compiled image prompts document
itv_video_prompt_document_id (uuid) - Reference to Phase 2 compiled motion prompts document
itv_video_folder_document_id (uuid) - Reference to final ITV video folder document
```

#### Updated `tabs` Table (ITV-related columns)

```
visual_type (varchar)           - 'image', 'ttv', or 'itv' (default: 'image')
process_itv (boolean)           - Whether ITV is enabled (default: false)
itv_model (varchar)             - Selected ITV video model (default: 'wan22')
itv_duration (numeric)          - ITV clip duration (default: 6)
itv_audio_clip (boolean)        - ITV audio clip flag (default: false)
```

**Version Numbering for ITV**:

- Version 16: ITV Phase 1 image prompt document (original story)
- Version 17: ITV Phase 1 image prompt document (corrected story)
- Version 20: ITV Phase 2 motion prompt document (original story)
- Version 21: ITV Phase 2 motion prompt document (corrected story)
- Version 22: ITV video folder (original story)
- Version 23: ITV video folder (corrected story)

### Frontend Components

#### `ImageToVideoGeneratorContainer.tsx`

**Purpose**: Wrapper component managing tab state and ImageToVideoGenerator lifecycle.

**Key Responsibilities**:

- Checks enterprise user status
- Manages multiple ITV tab configurations
- Forces ImageToVideoGenerator remount on tab changes for complete isolation
- Handles tab creation, switching, and cleanup

#### `ImageToVideoGenerator.tsx`

**Purpose**: Main ITV generation interface (~4,000 lines) with advanced 4-phase pipeline visualization.

**Key Features**:

- **Two Generation Modes**:
  - **Document mode**: Convert entire story document to video sequence through 4 phases
  - **Single ITV mode**: Generate single video clip from individual image + prompt (via `single-ITV`)

- **6 Image Model Tiers** (for keyframe generation):

  | Tier     | Model                      | Tokens/Image |
  | -------- | -------------------------- | ------------ |
  | Entry    | flux-2-dev                 | 7,000        |
  | Standard | imagen-4-fast              | 14,000       |
  | Plus     | gpt-image-1-mini           | 30,000       |
  | Pro      | seedream-4.5 (recommended) | 35,000       |
  | Elite    | imagen-4-ultra             | 42,000       |
  | Ultimate | nano-banana-pro            | 100,000      |

- **9 ITV Video Models** across 6 tiers:

  | Tier     | Model                              | Resolution | Tokens/sec             | Audio |
  | -------- | ---------------------------------- | ---------- | ---------------------- | ----- |
  | Entry    | Wan 2.2 ITV                        | 480p       | 6,000                  | No    |
  | Standard | Seedance 1.0 Fast                  | 720p       | 12,960                 | No    |
  | Standard | Hailuo 2.3 Fast                    | 720p       | 19,200                 | No    |
  | Plus     | Seedance 1.5 Pro ITV (recommended) | 1080p      | 34,800 (70.2K w/audio) | Yes   |
  | Pro      | LTX 2.3 Fast ITV                   | 1440p      | 48,000                 | Yes   |
  | Pro      | Veo 3.1 Fast ITV                   | 1080p      | 60,000 (90K w/audio)   | Yes   |
  | Elite    | LTX 2.3 Pro ITV                    | 1440p      | 72,000                 | Yes   |
  | Elite    | Veo 3.1 ITV                        | 1080p      | 120,000 (240K w/audio) | Yes   |
  | Ultimate | LTX 2.3 Pro 4K ITV                 | 2160p      | 144,000                | Yes   |

- **4-Phase Progress Tracking**:
  - Phase 1: Image prompts (polling every 6s)
  - Phase 2: Keyframe images (polling every 8s) — concurrent with Phase 3
  - Phase 3: Motion prompts (polling every 6s) — concurrent with Phase 2
  - Phase 4: Video animation (polling every 10s)

- **Redo Options** (modal on completion):
  - `image_and_video`: Regenerate both keyframe image and video clip
  - `video_only`: Keep existing keyframe, regenerate video only (faster, cheaper)

- **Character Consistency**: Optional AI-powered character extraction and enhancement

- **Language Selection**: English, German, Spanish, French

- **AI Writing Model Selection**: DeepSeek (1x), Sonnet 4.6 (11x), Opus 4.6 (19x)

- **Resume Detection**: On page reload, queries ITV_prompt_tasks, image_tasks, ITV_tasks to restore state

**State Flow**:

1. User selects story document or uploads image for single ITV
2. Configures image model (for keyframes), video model (for animation), duration
3. Optionally enables character consistency, audio clips
4. Token estimation displayed with 4-phase breakdown
5. Clicks "Generate ITV"
6. Phase 1: Image prompts generated (progress polled every 6s)
7. Phase 2 + 3: Keyframe images + motion prompts generated concurrently
8. Phase 4: Images animated into video clips (polling every 10s)
9. On completion: ZIP download available, individual clip preview, redo options

#### `ITVVideoModelSelector.tsx`

**Purpose**: Model selection grid component for ITV video models.

**Features**:

- 9 ITV models in responsive grid layout
- Each card shows: resolution, tokens/second, duration options
- Audio support indicator (speaker badge) for compatible models
- Processing speed estimate (e.g., "~120s/clip")
- Example video preview with play button
- Recommended model highlighted (Seedance 1.5 Pro ITV)
- Models with `selectable: false` use fixed durations

#### `VisualConfiguration.tsx` (ITV Section)

**Purpose**: Within the Video Generator pipeline (Step 2), the Image-to-Video tab provides:

- Image model selection (6 tiers)
- ITV video model selection (ITVVideoModelSelector)
- Duration configuration
- Audio clip toggle
- Character consistency with AI enhancement
- Integrates with frequency configuration for image count

### Backend Functions

#### Deno Deploy Functions

##### `setup-itv-prompts.ts`

**Purpose**: Initializes ITV job setup from user request. Validates tokens, extracts characters, segments text, stores settings, and kicks off Phase 1.

**Process**:

1. Validates request: user_id, group_id, file_path, story_title, video_model, clip_duration, totalAudioDuration
2. Estimates tokens for all 4 phases:
   - Phase 1: Image prompts (800 × clips × model_multiplier)
   - Phase 2: Image generation (tokens_per_image × clips)
   - Phase 3: Motion prompts (800 × clips × model_multiplier)
   - Phase 4: Video generation (tokens_per_second × duration × clips)
3. Checks user token balance (unless `videoProcess=true` where tokens are pre-validated)
4. **Character Extraction** (optional):
   - If `useCharacterDescriptions=true`: Calls DeepSeek to extract 3-5 main characters with visual descriptions
5. Calculates video clip count: `ceil(totalAudioDuration / clip_duration)`
6. Normalizes text: strips SSML breaks, fixes encoding, cleans chapter markers
7. Splits large text into parts (max 56,000 chars per part)
8. Segments text into exact N segments using `forceExactSegments()`
9. **Stores ITV_prompt_context**: One row per text part with video_model, video_duration, audio_clip, style, characters, `itv=false` (Phase 1)
10. Creates `job_data` row with full job config
11. Triggers `process-itv-task.ts`

##### `process-itv-task.ts`

**Purpose**: Creates Phase 1 ITV_prompt_tasks batch rows from job data.

**Process**:

1. Fetches job data from `job_data` table
2. Validates required fields
3. Prevents duplicate creation (checks for existing tasks in last 5 minutes)
4. Normalizes segments (supports both `segmentsByPart` and flat `segments[]` arrays)
5. Creates batches of 2 segments each
6. Inserts ITV_prompt_tasks rows:
   - `itv=false` (Phase 1)
   - Version 16 (original) or 17 (corrected)
   - First task: `status='queued'`, rest: `status='pending'`
7. Inserts in 20-row chunks with 200ms delays
8. Fires `trigger-next-ITV-prompt` with `itv=false`

**Key Constants**:

```typescript
BATCH_SIZE = 2; // Segments per batch
MAX_TEXT_PART_CHARS = 56000; // Max chars per text_part
MIN_TEXT_PART_LENGTH = 50; // Minimum segment length
MAX_RETRIES = 3; // For task inserts
TASK_INSERT_CHUNK = 20; // Rows per batch insert
```

#### Supabase Edge Functions

##### `generate-ITV-prompt/`

**Purpose**: Dual-phase AI prompt generator. Phase 1 generates keyframe image descriptions; Phase 2 generates motion/animation prompts.

**Phase 1 (itv=false)** — Image Prompt Generation:

1. Fetches full story context from ITV_prompt_context
2. Builds system prompt emphasizing:
   - **CRITICAL**: "No visible text, letters, words, signs" in generated images
   - Single keyframe per segment (200-300 words)
   - Must imply motion for eventual video generation
   - Uses character descriptions if provided
3. Sends batch_segments to AI model (streaming for DeepSeek, direct for Anthropic)
4. Parses JSON response: `[{text, image_prompt, characters_mentioned}]`
5. Appends style block + selective character descriptions
6. Returns results with token counts

**Phase 2 (itv=true)** — Motion Prompt Generation:

1. Receives phase2_segments with `{text, image_prompt, index}`
2. Builds system prompt for animation/motion description
3. Extracts motion verbs, implied actions from text + keyframe description
4. Generates 100-200 word motion prompts per segment
5. Returns: `[{text, prompt}]`

**Model Support**:

```typescript
TOKEN_PER_WORD = 1.33;
MODEL_CONFIGS = {
  deepseek: { multiplier: 1 }, // OpenAI-compatible, streaming
  sonnet: { multiplier: 11 }, // Anthropic direct
  opus: { multiplier: 19 }, // Anthropic direct
};
```

##### `process-ITV-prompt/`

**Purpose**: Orchestrates Phase 1 and Phase 2 prompt generation batches. Manages state transitions and triggers the next pipeline phases.

**Process**:

1. Validates input, fetches ITV_prompt_task
2. Guards against stuck tasks (age > 5 min → reset to 'queued')
3. Calls `generate-ITV-prompt` with phase1_segments (itv=false) or phase2_segments (itv=true)
4. Stores results in batch_output (JSON string)
5. Updates task status and token counts
6. Updates video_tasks progress (if part of video pipeline)

**On Last Batch of Phase 1**:

1. Aggregates all Phase 1 batch_output into single image prompts document
2. Creates `story_documents` record (version 16/17)
3. **Triggers two parallel processes**:
   - Calls `setup-image-tasks` with `itv=true` → starts keyframe image generation (Phase 2)
   - Creates Phase 2 ITV_prompt_tasks rows (same batch structure, `itv=true`)
   - Fires `trigger-next-ITV-prompt` with `itv=true` → starts motion prompt generation (Phase 3)

**On Last Batch of Phase 2**:

1. Aggregates all Phase 2 batch_output into motion prompts document
2. Creates `story_documents` record (version 20/21)
3. **Dual-Completion Check**:
   - Verifies `image_tasks` (itv=TRUE) are all completed
   - If BOTH Phase 2 prompts AND images are complete → fires `setup-ITV-tasks` to pair prompts with keyframes
   - If images still processing → marks Phase 2 as ready, waits for image completion callback

##### `setup-ITV-tasks/`

**Purpose**: Called when BOTH Phase 2 motion prompts AND Phase 2 keyframe images are complete. Pairs prompts with image URLs and creates individual ITV_tasks.

**Process**:

1. Finds Phase 2 video prompts document (version 20/21) in `story_documents`
2. Downloads and parses JSON: `[{text, prompt}]`
3. Fetches ITV settings from `ITV_prompt_context` (video_model, video_duration, audio_clip, image_model)
4. Extracts completed keyframe image URLs from `image_tasks` (itv=true) batch_output
5. Checks variant collision, auto-increments if needed
6. Creates one ITV_task per prompt-image pair:
   - `batch`: `[{text, prompt, image_url, image_number, index}]`
   - Version 22 (original) or 23 (corrected)
   - First task: `status='queued'`
7. Inserts in 20-row chunks
8. Fires `trigger-next-ITV` to start Phase 4

##### `generate-ITV/`

**Purpose**: API gateway for image-to-video generation. All models route through fal.ai.

**Two Modes**:

- **Submit**: Takes image_url + prompt → returns `{status, polling_id, polling_url}`
- **Poll**: Takes polling_id → returns `{status, video_url?, error?}`

**Model API Routing** (all via fal.ai):

| Model                | fal.ai Model ID                           | Duration | Resolution |
| -------------------- | ----------------------------------------- | -------- | ---------- |
| Wan 2.2 ITV          | fal-ai/wan/v2.2/1.3b/image-to-video       | 5s fixed | 480p       |
| Seedance 1.0 Fast    | fal-ai/seedance/image-to-video            | 5s/10s   | 720p       |
| Hailuo 2.3 Fast      | fal-ai/hailuo/video/image-to-video        | 4-6s     | 720p       |
| Seedance 1.5 Pro ITV | fal-ai/seedance-1.5/image-to-video        | 5s/10s   | 1080p      |
| LTX 2.3 Fast ITV     | fal-ai/ltx-video/v2.3/fast/image-to-video | 5-9s     | 1440p      |
| Veo 3.1 Fast ITV     | fal-ai/veo3/image-to-video/fast           | 4-8s     | 1080p      |
| LTX 2.3 Pro ITV      | fal-ai/ltx-video/v2.3/image-to-video      | 5-9s     | 1440p      |
| Veo 3.1 ITV          | fal-ai/veo3/image-to-video                | 4-8s     | 1080p      |
| LTX 2.3 Pro 4K ITV   | fal-ai/ltx-video/v2.3/image-to-video      | 5-9s     | 2160p      |

##### `process-ITV/`

**Purpose**: Main ITV video generation orchestrator. Manages job submission, polling, video download/upload, and final document compilation.

**Key Constants**:

```typescript
INITIAL_POLL_DELAY_MS = 90000; // 90s for all fal.ai models
MAX_IN_PROCESS_POLL_ATTEMPTS = 3; // polls per invocation
MAX_TOTAL_POLL_ATTEMPTS = 5; // max across self-call chain
MAX_WAIT_MS = 380000; // stay under 400s edge function budget
LONG_POLL_MODELS = new Set(); // currently empty (all fal.ai are short-poll)
```

**Process**:

1. Fetches queued ITV_task from database
2. Extracts prompt, image_url, video_duration from task
3. Calls `generate-ITV` (submit mode)
4. Stores polling_id/polling_url, returns HTTP 200 immediately
5. In EdgeRuntime.waitUntil:
   - Sleeps 90s, enters poll loop (3 attempts per invocation)
   - On completion: downloads video, strips audio if needed (seedance15 always generates audio)
   - Uploads to `documents/{userId}/{groupId}/ITV-{sanitized}_{timestamp}/{batchNumber}.mp4`
   - Calculates tokens: `duration × (audioClip ? AUDIO_TOKENS[model] : TOKENS[model])`
6. On last batch → `compileFinalITVDocument`:
   - Creates `story_documents` (version 22/23)
   - Sets `itv_video_folder_document_id` on all tasks
   - Marks `tabs.status='complete'`
   - Bridges to video pipeline (if `video_tasks` with `visual_type='itv'`)

##### `trigger-next-ITV/`

**Purpose**: Queues the next pending ITV_task and fires `process-ITV`.

Mirrors `trigger-next-TTV` but operates on ITV_tasks table.

##### `trigger-next-ITV-prompt/`

**Purpose**: Queues next ITV prompt batch (Phase 1 or Phase 2) and fires `process-ITV-prompt`.

Accepts `itv` boolean flag to differentiate between Phase 1 (`itv=false`) and Phase 2 (`itv=true`) tasks.

##### `redo-ITV/`

**Purpose**: Regenerates a single ITV video clip. Supports two entry points:

1. **User-initiated**: Direct redo via frontend with Bearer token auth
2. **Chained from redo-image**: When keyframe image is regenerated, `redo-image` fires `redo-ITV` to regenerate the corresponding video

**Process**:

1. Authenticates user (JWT or user_id from redo-image chain)
2. Fetches ITV_task by batch_number
3. Validates token balance
4. Uses stored image_url (or new one from redo-image)
5. Sets `redo_status='redoing'`
6. Returns 202, processes in background
7. Submits job to generate-ITV, polls until completion
8. Downloads video, strips audio if seedance15 + !audioClip
9. Uploads to same storage path (upsert)
10. Charges tokens, clears redo_status

**MP4 Audio Stripper** (pure JS, no FFmpeg):

```typescript
// Walks MP4 box structure: finds moov → trak → hdlr
// Identifies audio tracks by handler_type = 'soun'
// Removes audio trak boxes, patches chunk offsets
// Result: video-only MP4
```

**Key Constants**:

```typescript
MAX_TOTAL_POLL_ATTEMPTS = 10; // longer for single redo (60 min within fal.ai expiry)
MAX_WAIT_MS = 340000; // 60s buffer before 400s edge limit
```

##### `single-ITV/`

**Purpose**: Generates a single ITV video from a pre-generated keyframe image (standalone, not part of batch pipeline).

**Process**:

1. Receives task_id (already created by `single-image` after keyframe upload)
2. Updates task status to 'running'
3. Extracts prompt and image_url from task
4. Submits job to generate-ITV
5. Polls until completion (MAX_TOTAL_POLL_ATTEMPTS=60 for single clips)
6. Downloads video, strips audio if needed
7. Uploads to `documents/{userId}/{groupId}/ITV-single_{timestamp}/1.mp4`
8. Marks `completed_final`, charges tokens

**Interaction**: Chained from `single-image` edge function after keyframe is generated

#### Google Cloud Functions

##### `image-to-video-processor.py` (and variants 2-5)

**Purpose**: Orchestrates final video assembly for ITV output — management, resizing, effects application. 5 load-balanced copies (1-5) for high throughput.

**Key Functions**:

- `calculate_stt_tokens()`: Calculate tokens by audio duration
- `check_user_token_balance()`: Validate sufficient tokens before processing
- `verify_service_role_key()`: Auth check for service role access
- `download_file()`: Retry-based URL download from storage
- `create_optimized_long_video()`: Base video generation (95% faster via pattern optimization)
- MP4 operations: muxing, effects, resizing, transitions

**Integration**: Called by `setup-video-tasks` when all ITV clips are ready for final video assembly. Handles the combination of ITV clips with audio, transitions, effects, and background music into the final output video.

### Token Costs

#### ITV Token Calculation (4 Phases)

```typescript
// Phase 1: Image Prompts
phase1_tokens = 800 × num_clips × model_multiplier

// Phase 2: Image Generation
IMAGE_TOKENS_PER_IMAGE = {
  'flux-2-dev': 7000,
  'imagen-4-fast': 14000,
  'gpt-image-1-mini': 30000,
  'seedream-4.5': 35000,       // recommended
  'imagen-4-ultra': 42000,
  'nano-banana-pro': 100000,
}
phase2_tokens = tokens_per_image × num_clips

// Phase 3: Motion Prompts
phase3_tokens = 800 × num_clips × model_multiplier

// Phase 4: Video Generation
ITV_TOKENS_PER_SECOND = {
  wan22: 6000,
  seedance1fast: 12960,
  hailuo23fast: 19200,
  seedance15: 34800,
  ltx23fast: 48000,
  veo31fast: 60000,
  ltx23pro: 72000,
  veo31: 120000,
  ltx23pro4k: 144000,
}

// Audio-enabled models (2× cost):
ITV_AUDIO_TOKENS_PER_SECOND = {
  seedance15: 70200,
  veo31fast: 90000,
  veo31: 240000,
}

phase4_tokens = tokens_per_second × duration × num_clips

// Total:
total_itv_tokens = phase1 + phase2 + phase3 + phase4
```

### User Workflows

#### Standalone ITV Generation

1. Navigate to Image-to-Video page
2. Select source document from document browser
3. Choose image model (for keyframes) and video model (for animation)
4. Configure clip duration, optionally enable audio clips
5. Select AI writing model for prompt generation
6. Optionally enable character consistency
7. Click "Generate ITV"
8. Phase 1: Image prompts generated (progress polled every 6s)
9. Phase 2 + 3 (concurrent):
   - Keyframe images generated (progress polled every 8s)
   - Motion prompts generated (progress polled every 6s)
10. Phase 4: Images animated into video clips (progress polled every 10s)
11. Download individual clips or entire ZIP archive
12. Redo modal: regenerate as `image_and_video` or `video_only`

#### ITV in Video Pipeline

1. In Video Generator, Step 2 (Visual Configuration) → select "Image-to-Video" tab
2. Configure image model, ITV video model, duration
3. Continue to Step 3 (Audio) and Step 4 (Video Configuration)
4. Video pipeline executes: Story → ITV Phases 1-4 → Audio → Final Video Assembly
5. ITV completion bridges to `setup-video-tasks` for final MP4 assembly

#### Single ITV Generation

1. On Image-to-Video page, switch to "Single ITV" mode
2. Enter prompt or text description
3. Select ITV video model and duration
4. System generates keyframe image via `single-image`
5. `single-image` automatically chains to `single-ITV`
6. Resulting video clip available for preview and download

### Error Handling & Recovery

- **Stuck Task Recovery**: Cron job `check_stuck_ITV_tasks()` runs every 20 minutes with two-phase detection (same pattern as story/audio/TTV)
- **Dual-Completion Guard**: Phase 2 prompts and images must both complete before Phase 4 begins; each side checks the other on completion
- **fal.ai Expiry**: Poll results expire after ~1 hour; redo-ITV resubmits if `HTTP 405` received
- **Self-Call Polling**: Chains via self-calls to handle fal.ai queue times within 400s edge function limit
- **Retry Logic**: 6 exponential backoff attempts for API calls
- **Audio Stripping**: Pure-JS MP4 parser removes audio tracks for models that always generate audio

### Pipeline Flow

```
Frontend Request
    ↓
setup-itv-prompts.ts (Deno Deploy)
    ├→ Validate tokens, extract characters
    ├→ Segment text, store ITV_prompt_context (itv=false)
    └→ Create job_data
        ↓
process-itv-task.ts (Deno Deploy)
    ├→ Create ITV_prompt_tasks (itv=false, Phase 1)
    └→ Fire trigger-next-ITV-prompt (itv=false)
        ↓
═══════════════ PHASE 1: Image Prompts ═══════════════
trigger-next-ITV-prompt → process-ITV-prompt → generate-ITV-prompt (itv=false)
    ↓ (batch loop until all Phase 1 batches done)
On last Phase 1 batch:
    ├→ Create story_documents (v16/17) — compiled image prompts
    ├→ Fire setup-image-tasks (itv=true) ─────────────────────┐
    ├→ Create Phase 2 ITV_prompt_tasks (itv=true)             │
    └→ Fire trigger-next-ITV-prompt (itv=true) ───┐           │
                                                   │           │
═══ PHASE 3: Motion Prompts (concurrent) ═══       │  ═══ PHASE 2: Keyframe Images ═══
trigger-next-ITV-prompt (itv=true)                 │  setup-image-tasks → image generation
    ↓                                              │      ↓
process-ITV-prompt → generate-ITV-prompt           │  trigger-next-image → process-image
    ↓ (batch loop)                                 │      ↓ (batch loop)
On last Phase 2 batch:                             │  On last image batch:
    ├→ Create story_documents (v20/21)             │      ├→ Compile images folder
    └→ Dual-completion check ──────────────────────┘──────┘
        ↓
═══════════════ PHASE 4: Video Animation ═══════════════
(Only when BOTH Phase 2 images AND Phase 3 prompts complete)
setup-ITV-tasks
    ├→ Pair prompts with keyframe image URLs
    ├→ Create ITV_tasks (one per clip)
    └→ Fire trigger-next-ITV
        ↓
trigger-next-ITV → process-ITV → generate-ITV (fal.ai)
    ↓ (poll loop per clip, with self-call chains)
    ├→ Download video → Upload to storage
    └→ On last clip:
        compileFinalITVDocument
        ├→ Create story_documents (v22/23)
        ├→ Mark tabs.status='complete'
        └→ Bridge to video_tasks → setup-video-tasks (if pipeline)
```

### Storage Organization

```
Supabase Storage "stories" bucket:
  documents/{user_id}/
    {group_id}/
      TTV-{sanitized_title}_{timestamp}/
        1.mp4
        2.mp4
        ...
      ITV-{sanitized_title}_{timestamp}/
        1.mp4
        2.mp4
        ...
      ITV-single_{timestamp}/
        1.mp4
```

### Storage Estimation

```
TTV: ~4 MB per video clip
ITV: ~1 MB per keyframe image + ~6 MB per video clip
```

### Performance Optimizations

1. **Concurrent Phases** (ITV): Phase 2 (images) and Phase 3 (motion prompts) run in parallel
2. **Batch Size**: 2 segments per batch for prompt generation
3. **Chunked Inserts**: 20 rows per database insert with 200ms delays
4. **Self-Call Polling**: Stays under 400s edge function budget while handling long-running jobs
5. **Wan 2.2 Fallback** (TTV): Automatically switches from ModelsLab to fal.ai after slow response
6. **Audio Stripping**: Pure-JS MP4 parser (no FFmpeg dependency) for removing unwanted audio
7. **Token Tracking via DB Triggers**: `ttv_tasks_tokens_update` and `itv_tasks_tokens_update` triggers handle token deduction automatically

---

## Motion Graphics (MG) Generator

The **Motion Graphics generator** is an AI-codegen video pipeline. Instead of calling a third-party text-to-video model, NorthNoir generates a bespoke [Remotion](https://www.remotion.dev) React/TSX clip *per text segment* using Claude, then renders it on AWS Lambda via `@remotion/lambda`. The result is fully programmatic, vector-precise motion graphics (titles, charts, maps, kinetic typography, glassmorphic UI, voxel scenes, etc.) tightly synced to the narrated audio.

MG is available as:

- A **standalone page** (`/motion-graphics`) for direct MG generation
- A **visual type option** within the Video Generator pipeline (Step 2: Visual Configuration → Motion Graphics tab, `visual_type='mg'`)

### Architecture Overview

```
Frontend (MotionGraphicsGenerator.tsx)
   │
   ├─ Batch mode ──► setup-mg-prompts (Supabase)
   │                    │
   │                    ├─ trigger-next-MG-prompt → process-MG-prompt → generate-MG-prompt
   │                    │   (Claude/DeepSeek: text segment → motion_graphic_prompt + duration)
   │                    │
   │                    └─ On last prompt batch:
   │                          setup-MG-tasks → INSERT MG_tasks (status='code_gen', single_mg=false)
   │                                       └─ trigger-next-MG → process-MG → single-MG  ─┐
   │                                                                                      │
   └─ Single-clip / Redo ──► single-MG (Supabase)  ────────────────────────────────────────┤
                                                                                          │
                                                                                          ▼
                                              ┌──────────────────────────────────────────────────┐
                                              │  mg-codegen-worker  (AWS Lambda, eu-north-1)     │
                                              │  Node 22 container, ARM64                        │
                                              │                                                  │
                                              │  1. Load Remotion project skeleton + skills      │
                                              │  2. Claude Opus / Sonnet → bespoke Clip.tsx      │
                                              │  3. esbuild validate (≤3 auto-repair attempts,   │
                                              │     fallback stub on final failure)              │
                                              │  4. @remotion/bundler → deploySite() per task    │
                                              │     to s3://remotionlambda-eunorth1-…/sites/     │
                                              │     mg-jobs/<task_id>/                           │
                                              │  5. renderMediaOnLambda → render_id              │
                                              │  6. UPDATE MG_tasks (status='rendering',         │
                                              │     render_id, bundle_url)                       │
                                              │  7. POST process-mg-task (Deno Deploy)           │
                                              └──────────────────────────────────────────────────┘
                                                                                          │
                                                                                          ▼
                                              ┌──────────────────────────────────────────────────┐
                                              │  process-mg-task  (Deno Deploy worker)           │
                                              │  Polls renderMediaOnLambda progress, downloads   │
                                              │  the finished MP4, uploads to Supabase Storage,  │
                                              │  bills tokens via gcf_runtime_log, sets          │
                                              │  MG_tasks.video_url + status='completed'.        │
                                              └──────────────────────────────────────────────────┘
```

Two complementary entry points share the same `MG_tasks` schema:

- **`single-MG`** — used for single-clip generation, redos, and the standalone page's quick previews. Calls Claude inline to produce the `motion_graphic_prompt`, inserts one `MG_tasks` row with `single_mg=true`, then `EdgeRuntime.waitUntil`s the Lambda invoke.
- **`setup-MG-tasks` + `process-MG`** — batch pipeline. `setup-MG-tasks` reads compiled `MG_prompt_tasks.batch_output`, inserts one `MG_tasks` row per clip, and fires `trigger-next-MG`. `process-MG` is a lightweight per-row orchestrator that calls the Lambda and writes status transitions.

### Database Schema

#### `MG_prompt_context` Table

One row per text part per MG generation run. Stores the story text, style choices, and codegen model selection that the prompt generator needs.

```
id (uuid)                       - Primary key
group_id (uuid)                 - Groups all tasks for this MG run
user_id (uuid)
full_story_text (text)          - Complete text for this part
word_count, character_count (integer)
master_prompt_data (jsonb)      - Style / setting / atmosphere / characters
style_slug (varchar)            - One of mgStyles.ts slugs (e.g. 'cinematic_dark')
style_guidance (text)           - Long-form visual direction (style preset OR
                                  the user's freeform override)
codegen_model (varchar)         - 'opus' | 'sonnet' (Claude model for Clip.tsx)
clip_seconds (numeric)          - Target seconds per clip (default 8)
total_clips (integer)           - Expected total clips for this part
tab, part_number (integer)
created_at, updated_at (timestamptz)
```

#### `MG_prompt_tasks` Table

Tracks Claude prompt-generation batches (text segment → `motion_graphic_prompt`). Same lifecycle shape as `TTV_prompt_tasks` / `ITV_prompt_tasks`.

```
id (uuid)                       - Primary key
user_id, group_id (uuid)
story_title, description (text)
batch (jsonb)                   - [{text, index}]
batch_output (text)             - JSON: [{text, motion_graphic_prompt, duration}]
total_batches, batch_number (integer)
total_prompts, total_clips (integer)
progress (integer 0-100)
status (varchar)                - 'pending'|'queued'|'running'|'completed'|
                                  'completed_final'|'error'
error (text)
settings (jsonb)
variant (integer)
doc_id (uuid)
file_path (text)
input_tokens, output_tokens (integer)
version (integer)               - 24 = original, 25 = corrected
model (text)                    - Prompt-writer LLM ('deepseek'|'sonnet'|'opus')
codegen_model (text)            - 'opus'|'sonnet' (forwarded to MG_tasks)
language (text)
tab (integer)
clip_seconds (numeric)
is_corrected (boolean)
```

#### `MG_tasks` Table

One row per rendered Remotion clip. The Lambda worker reads `style_guidance` + `motion_graphic_prompt` + `clip_seconds`, generates a `Clip.tsx`, deploys a per-task site, and renders.

```
id (uuid)                       - Primary key (also used as Remotion task_id)
user_id, group_id (uuid)
tab, part_number, clip_index (integer)
motion_graphic_prompt (text)    - Per-clip prompt from MG_prompt_tasks output
style_slug (varchar)
style_guidance (text)           - Snapshotted style brief (so post-hoc style
                                  edits don't affect already-rendered clips)
codegen_model (varchar)         - 'opus' | 'sonnet'
clip_seconds (numeric)          - Target render duration
status (varchar)                - 'code_gen' | 'rendering' | 'completed' | 'error'
render_id (text)                - @remotion/lambda render handle
bucket_name (text)              - Remotion S3 bucket
bundle_url (text)               - Per-task deployed site URL
video_url (text)                - Final MP4 in Supabase Storage
input_tokens, output_tokens (integer)  - Claude codegen tokens (Opus/Sonnet)
codegen_cost_usd (numeric)      - API cost (pre-margin)
lambda_cost_usd (numeric)       - AWS Lambda + Remotion render cost
total_tokens_billed (integer)   - Final platform tokens charged
single_mg (boolean)             - true = redo / single-clip path
version (integer)               - 24/25 mirror story versioning
language (text)
is_corrected (boolean)
created_at, updated_at (timestamptz)
```

### Frontend Components

| File | Purpose |
| --- | --- |
| `src/pages/MotionGraphicsGenerator.tsx` | Standalone MG page. Document picker, style picker, codegen-model picker, batch + single-clip modes, polling, ZIP download. |
| `src/pages/MotionGraphicsGeneratorContainer.tsx` | Route container — initializes Supabase + tab session. |
| `src/components/MGStyleSelector.tsx` | Style picker with example MP4 previews from the `websitestuff` Supabase bucket. |
| `src/data/mgStyles.ts` | Single source of truth for all 16 MG style presets (slug, display_name, description, `style_guidance` brief, example video path). |

### Style Presets (`mgStyles.ts`)

16 curated codegen-ready style briefs. Each preset's `style_guidance` is a 2–3 sentence brief (palette mood with 1–2 hex anchors, atmosphere, motion vibe, typography family) passed verbatim to Claude:

`cinematic_dark`, `realistic_map`, `voxel_pixel_people`, `hyperreal_3d_figures`, `bright_infographic`, `dark_terminal_stocks`, `watercolor_historical`, `sketch_pen_paper`, `atmospheric_fog`, `glassmorphism`, `kinetic_typography`, `brutalist_newspaper`, `flat_explainer`, `swiss_minimal`, `corporate_data`, `holographic_glitch`.

Users can override with a freeform `styleDescription` string from the MG page — that string is written to `MG_tasks.style_guidance` instead of the preset.

### Backend Functions

#### Supabase Edge Functions (`supabase/functions/`)

| Function | Role |
| --- | --- |
| `setup-mg-prompts` | Splits the story into segments, creates `MG_prompt_context` + `MG_prompt_tasks` rows, fires `trigger-next-MG-prompt`. |
| `trigger-next-MG-prompt` | Picks the next pending prompt batch, hands it to `process-MG-prompt`. |
| `process-MG-prompt` | Per-batch orchestrator → calls `generate-MG-prompt`, writes `batch_output`, updates progress, fires self-call for next batch or `setup-MG-tasks` on completion. |
| `generate-MG-prompt` | Claude/DeepSeek call: text segment → `{motion_graphic_prompt, duration}`. |
| `setup-MG-tasks` | After all prompt batches complete: reads compiled `batch_output` rows, inserts one `MG_tasks` row per clip with `style_guidance` snapshotted, fires `trigger-next-MG`. |
| `trigger-next-MG` | Picks next `MG_tasks` row with `status='code_gen'`, fires `process-MG`. |
| `process-MG` | Lightweight per-clip orchestrator that POSTs the Lambda Function URL with the task payload and writes `status='rendering'`. |
| `single-MG` | One-shot path: Claude → `motion_graphic_prompt`, insert one `MG_tasks` row with `single_mg=true`, invoke Lambda directly. |
| `redo-MG` | Re-runs a single existing `MG_tasks` row (re-uses original prompt + style, regenerates `Clip.tsx`). |
| `empty-redo-MG` | Marks the row blank/regenerable when the user wants the prompt itself regenerated. |
| `stop-MG-processing` | User-initiated cancel — sets remaining `MG_tasks` to `'error'` with `'cancelled'` flag and stops further triggers. |
| `process-mg-task` (Deno Deploy) | Polls `renderMediaOnLambda` progress, downloads final MP4, uploads to Supabase Storage, writes `video_url`, bills tokens via `gcf_runtime_log`. |

#### AWS Lambda Worker (`mg-codegen-worker/`)

Node 22 ARM64 container deployed to `eu-north-1`. Build / deploy:

```bash
cd mg-codegen-worker
npm run prepare-context        # pull latest Remotion project skeleton + skills
docker build --platform linux/arm64 -t mg-codegen-worker:latest .
./scripts/push-to-ecr.sh
./scripts/deploy-lambda.sh
```

Lambda env vars: `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `REMOTION_BUCKET_NAME` (`remotionlambda-eunorth1-xeueiza279`), `REMOTION_FUNCTION_NAME` (`remotion-render-4-0-458-mem3008mb-disk10240mb-240sec`), `REMOTION_REGION` (`eu-north-1`), `PROCESS_MG_TASK_URL`, `PROCESS_MG_TASK_AUTH`, `FUNCTION_URL_AUTH_TOKEN`. See `mg-codegen-worker/README.md` and `mg-codegen-worker/DEPLOY.md` for full deploy instructions.

### Cost Model & Token Billing

Two cost components per clip, both billed via platform tokens at the standard $2 per 1M-token rate:

1. **Claude codegen** (per-clip `Clip.tsx` generation, average ~1,000 input / ~6,000 output tokens, +15% auto-repair buffer):
   - Opus pricing: $5 input / $25 output per 1M tokens
   - Sonnet pricing: $3 input / $15 output per 1M tokens
   - User charge: `api_cost / (1 - 0.4)` (40% margin)
   - Platform tokens: `user_charge_usd × 500,000`
2. **Lambda + Remotion render** (per clip-second):
   - Base: `MG_BASE_COST_PER_SECOND = $0.0001507`
   - Margin: `1.5×`

Both are summed and stored on `MG_tasks.total_tokens_billed`. Users pick the codegen model on the MG page; Opus is the default for best Clip.tsx quality, Sonnet is ~1.7× cheaper.

### Storage

```
Supabase Storage "stories" bucket:
  documents/{user_id}/{group_id}/
    MG-{sanitized_title}_{timestamp}/
      1.mp4
      2.mp4
      ...
    MG-single_{timestamp}/
      1.mp4
```

Estimated ~5 MB per clip (higher than TTV's 4 MB — MG renders are vector-perfect, often higher bitrate). Estimated wall-clock ~90 seconds per Lambda clip render, used for the time-remaining UI display.

### Auto-Repair & Fallback

The Lambda's esbuild validation step retries failed Claude generations up to **3 times** with the error appended to the prompt. If all 3 attempts fail to compile, a **stub clip** is rendered (plain background + text) so the pipeline never hard-fails — the user can then redo just that clip via `redo-MG`.

---

## Story Comparison

The `/compare` page lets users diff two story documents side-by-side using AI. Powered by the `compare-stories` edge function (DeepSeek / Claude). Returns ratings (Overall Assessment, Narrative Structure, Character Development, Plot & Pacing, Writing Quality, Consistency & Continuity) plus actionable Recommendations. Implemented in `src/pages/Compare.tsx` via `performComparison()` from `src/utils/generator.ts`. See [API Reference](#api-reference) → `compareStories()`.

---

## Combine Video

The `/combine-video` page (`src/pages/CombineVideo.tsx`) lets users stitch together multiple finished video documents (from any of the Video, TTV, ITV, or MG pipelines) into a single MP4. Features:

- Browse + multi-select finished `story_documents` of video type
- Reorder clips via drag handles
- Background music selection + per-clip transition options
- Backed by `combine-video` / `compile-audio` Google Cloud Functions (FFmpeg/MoviePy)
- Output written to `documents/{user_id}/{group_id}/COMBINED-{title}_{timestamp}/final.mp4`
- Counts against the user's storage quota and is billed at the standard runtime-token rate via `gcf_runtime_log`

---

## Pricing & Subscription

NorthNoir runs a Stripe-backed subscription + token economy.

### Stripe Integration

- **Client**: `@stripe/stripe-js` loaded with `VITE_STRIPE_PUBLISHABLE_KEY` (public `pk_...` key — safe to ship in the browser bundle).
- **Edge functions**:
  - `create-checkout-session` — recurring subscription checkout.
  - `create-token-purchase-session` — one-off token top-ups.
  - `create-portal-session` — Stripe customer-portal redirect (manage plan, payment methods, invoices).
  - `manage-legacy-subscription` — migration helpers for grandfathered plans.
  - `downgrade-subscription` — explicit plan downgrade with proration handling.
  - `send-payment-failure-email` — dunning notification.
- **Webhook secret**: `STRIPE_WEBHOOK_SECRET` (server-side only, never exposed to the client).

### Plans & Tokens

Plan token allowances are defined in `src/data/planMaxTokens.ts` and surfaced via the `useIsLegacyPlan` hook. All AI/render work (LLMs, image models, video models, MG codegen + Lambda renders, GCF runtime) is metered in **platform tokens** at a unified rate of **$2 per 1,000,000 tokens**. Runtime billing for GCF workloads (final video assembly, combine-video, audio compile) is recorded in the `gcf_runtime_log` table.

### Frontend Pages

- `src/pages/Pricing.tsx` — plan picker + checkout entry.
- `src/pages/Subscription.tsx` — current plan, usage, manage / cancel.

---

## Deployment & Environment Variables

### Client-side (exposed in the production bundle)

Vite inlines these via `vite.config.ts`'s `define` block and the standard `VITE_*` prefix. They are visible in the browser — only put **public** keys here:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL (public). |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase anon / publishable key. Protected by Row-Level Security. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe `pk_...` key (safe to publish). |
| `VITE_FRONTEND_URL` | Canonical public site URL, used for redirects (Stripe return URLs, OAuth callbacks). |

### Server-side only (NEVER exposed to the client)

These are referenced only inside Supabase edge functions, Deno Deploy workers, AWS Lambda, and Google Cloud Functions. Keep them out of `VITE_*` and out of `vite.config.ts` `define`:

| Variable | Used by |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SECRET_KEY` | Edge functions, Lambda, GCF — privileged DB access. |
| `STRIPE_SECRET_KEY` | Stripe edge functions. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook handlers. |
| `ANTHROPIC_API_KEY` | Claude calls (prompt LLMs, MG codegen). |
| `DEEPSEEK_API_KEY` | DeepSeek calls. |
| `AWS_ACCESS_KEY` / `AWS_ACCESS_SECRET_KEY` | Remotion Lambda invocation + S3. |
| `MG_CODEGEN_WORKER_URL` / `MG_CODEGEN_WORKER_AUTH` | Lambda Function URL + bearer. |
| `OUTLINE_PROCESSOR_URL` | Long-running outline GCF endpoint. |
| `REPLICA_URL` | Read-replica DB URL (analytics queries). |

`.env` is gitignored; `dist/` and `mg-codegen-worker/scripts/env.sh` are also gitignored. Production secrets are configured in Vercel (frontend) and per-service dashboards (Supabase / Deno Deploy / AWS Lambda / GCF). If `.env` was ever historically committed, rotate every key — sourcemaps are enabled in production (`vite.config.ts` → `build.sourcemap: true`) which makes client source readable but does **not** leak server keys.

### Hosting topology

- **Frontend** → Vercel (`vercel.json`).
- **Supabase Edge Functions** → Supabase platform (`supabase/functions/`).
- **Deno Deploy workers** → `*.storyscriptai.deno.net` (long-poll orchestrators, `denodeploy/`).
- **AWS Lambda** → `mg-codegen-worker` (ECR container image, `eu-north-1`).
- **Google Cloud Functions** → final video assembly, transitions, audio compile, combine-video (`gcloudfunctions/`).
