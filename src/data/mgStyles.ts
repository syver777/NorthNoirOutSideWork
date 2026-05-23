// =============================================================================
// Motion Graphics Style catalog (single source of truth)
// =============================================================================
// Codegen-only pipeline:
//   - `description`     → short blurb shown in the UI picker.
//   - `style_guidance`  → short, vivid visual brief (2–3 sentences) passed
//                         verbatim to mg-codegen-worker as the
//                         `style_guidance` field on the MG_tasks row. This is
//                         what Claude Opus reads when generating the TSX clip.
//                         Capture the *essence*: palette mood (1–2 hex anchors
//                         max), atmosphere, motion vibe, typography family.
//                         Keep it concept-led — Claude infers specifics.
//   - `composition_id`  → DEPRECATED. Always 'Clip' under the codegen pipeline.
//                         Kept for backward compatibility with old rows.
//   - `example_video_path` → path under the `websitestuff` Supabase storage
//                         bucket for the example MP4 shown in the picker.
// =============================================================================

export interface MGStyleConfig {
  /** Stable, lowercase, snake_case key used in the DB (MG_tasks.style_slug). */
  slug: string;
  /** Human-readable label shown in the UI. */
  display_name: string;
  /** One-line description shown in the picker. */
  description: string;
  /**
   * Long-form visual direction handed to Claude Opus in the codegen worker.
   * The user can override this with a custom freeform string from the
   * MotionGraphicsGenerator page (styleDescription state).
   */
  style_guidance: string;
  /** DEPRECATED — always 'Clip' under codegen. Left for legacy rows. */
  composition_id: string;
  /** Storage path inside the `websitestuff` bucket for the example MP4. */
  example_video_path: string;
  /** Display order in the picker. */
  order_index: number;
  /** Toggle off without deleting. */
  is_active: boolean;
}

export const MG_STYLES: MGStyleConfig[] = [
  {
    slug: 'cinematic_dark',
    display_name: 'Cinematic Dark',
    description: 'Moody, cinematic, dark color grade with dramatic lighting and slow camera moves.',
    style_guidance:
      "Cinematic, film-noir mood on a near-black background (#0A0A12) with a single warm tungsten or deep teal accent. Heavy serif or condensed sans typography with generous letter-spacing; subjects emerge from a soft vignette via slow scale-and-fade reveals and subtle motion-blur trails. Pacing is reverent and slow — prestige documentary energy, never abrupt cuts.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/01_cinematic_dark.mp4',
    order_index: 1,
    is_active: true,
  },
  {
    slug: 'realistic_map',
    display_name: 'Realistic Map',
    description: 'Photoreal map flyovers with terrain, labels, and animated routes.',
    style_guidance:
      "Topographic atlas aesthetic: aged-parchment or muted-terrain background with fine contour lines, routes drawn as glowing polylines with stroke-dasharray growth and a leading pulse dot. Tiny all-caps sans-serif labels mark coordinates; compass rose and scale bar suggest cartography. Cool blue and warm amber accents, slow atlas pan.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/02_realistic_map.mp4',
    order_index: 2,
    is_active: true,
  },
  {
    slug: 'voxel_pixel_people',
    display_name: 'Voxel Pixel People',
    description: 'Stylized voxel/pixel people in 3D scenes — playful and game-like.',
    style_guidance:
      "Isometric voxel / Minecraft-style scene with chunky figures built from stacked colored rects, viewed at a 30° angle. Bright saturated palette (4–5 colors max), stepped pixel-perfect motion — never smooth interpolation. Chunky blocky monospaced typography; figures stagger in with tiny scale-bounces. Playful, game-like, no anti-aliased edges.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/03_voxel_pixel_people.mp4',
    order_index: 3,
    is_active: true,
  },
  {
    slug: 'hyperreal_3d_figures',
    display_name: 'Hyperreal 3D Figures',
    description: 'Hyperreal CGI figures in cinematic environments.',
    style_guidance:
      "Hyperreal faux-3D feel: human silhouettes or large shapes built from layered radial gradients and ellipses to imply volume, rim-lighting from upper-left, soft inner shadows. Deep misty gradient background (#1A1F2E → #4A5568) with cinematic letterbox bars. Heavy confident sans (Inter Black). Elements drift forward with parallax and weighty ease.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/04_hyperreal_3d_figures.mp4',
    order_index: 4,
    is_active: true,
  },
  {
    slug: 'bright_infographic',
    display_name: 'Bright Infographic',
    description: 'Bright, high-contrast infographic with clear typography and icons.',
    style_guidance:
      "Bright daytime-TV infographic on a clean WHITE or warm-cream background (#FFFFFF or #FFF8E7) — never dark. Bold flat color blocks (coral, mint, sunshine yellow, sky blue) bounce in with spring physics. Big rounded sans-serif headlines (weight 800), count-up numbers, bar charts growing from zero, cute icon-style shapes. Energetic, optimistic, friendly — no shadows or gradients.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/05_bright_infographic.mp4',
    order_index: 5,
    is_active: true,
  },
  {
    slug: 'dark_terminal_stocks',
    display_name: 'Dark Terminal Stocks',
    description: 'Dark Bloomberg-style terminal with tickers, charts, and data feeds.',
    style_guidance:
      "Bloomberg / financial-terminal aesthetic: pure black background (#000000), monospaced type throughout, amber (#FFB000) and green (#00FF41) text. Multi-panel dense layout with scrolling tickers, ASCII-style line charts via SVG polyline, data tables, and CRT scanline overlay. Every number flickers or updates live. Square corners, no decoration — pure information density.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/06_dark_terminal_stocks.mp4',
    order_index: 6,
    is_active: true,
  },
  {
    slug: 'watercolor_historical',
    display_name: 'Watercolor Historical',
    description: 'Watercolor textures with historical illustrations and aged paper.',
    style_guidance:
      "Painterly watercolor on aged ivory paper (#F5EDD8) with soft blotches of muted historical pigments — ochre, sage, dusty blue, sepia. Edges look bleeding and feathered via low-opacity layered fills and blur. Hand-lettered serif title in sepia ink with slight rotation; decorative filigree corners. Slow, contemplative reveals via opacity + ink-bleed scale.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/07_watercolor_historical.mp4',
    order_index: 7,
    is_active: true,
  },
  {
    slug: 'sketch_pen_paper',
    display_name: 'Sketch Pen & Paper',
    description: 'Hand-drawn ink sketches on paper with subtle motion.',
    style_guidance:
      "Pen-on-paper documentary sketch on cream paper with faint horizontal rule lines. Everything in thin wobbly black strokes (#1A1A1A) — irregular SVG paths that draw on with stroke-dasharray. Hatching for shadows, no fills. Handwriting-style font (Caveat). Scribbled marginal notes, occasional ink-blots. Motion is delicate pen-speed, never bouncy.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/08_sketch_pen_paper.mp4',
    order_index: 8,
    is_active: true,
  },
  {
    slug: 'atmospheric_fog',
    display_name: 'Atmospheric Fog',
    description: 'Volumetric fog and atmospheric particles with cinematic mood.',
    style_guidance:
      "Volumetric mist and fog: desaturated gradient background (#2C3E50 → #95A5A6) with soft cloud layers built from large low-opacity radial gradients drifting horizontally at parallax speeds. Faint silhouettes emerge through the fog with blur-to-focus transitions. Light-weight widely-spaced typography. Ethereal, haunting, dreamlike — nothing hurried, everything floats.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/09_atmospheric_fog.mp4',
    order_index: 9,
    is_active: true,
  },
  {
    slug: 'glassmorphism',
    display_name: 'Glassmorphism',
    description: 'Frosted glass cards, blur, and translucent layers in motion.',
    style_guidance:
      "Frosted-glass UI: floating translucent cards (rgba(255,255,255,0.15), backdrop-filter blur, 1px white inner border, large border-radius) over a vibrant gradient mesh background (#667EEA → #764BA2 → #F093FB). Cards stagger-in with slight tilt and rise. Soft white inner glow, Inter-style sans, numbers count up. Modern, premium, Apple-keynote feel.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/10_glassmorphism.mp4',
    order_index: 10,
    is_active: true,
  },
  {
    slug: 'kinetic_typography',
    display_name: 'Kinetic Typography',
    description: 'Bold typographic motion with rhythmic timing and color blocks.',
    style_guidance:
      "Dominated by motion typography: background flips between bold solid colors per beat (black, saturated red, electric yellow). Massive words enter, then scale, rotate, and swap colors to emphasize meaning. Two contrasting fonts — one heavy display (Anton/Bebas), one geometric accent. Color blocks slide in behind words via clip-path. Pacing is percussive, rhythmic, every beat punches.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/11_kinetic_typography.mp4',
    order_index: 11,
    is_active: true,
  },
  {
    slug: 'brutalist_newspaper',
    display_name: 'Brutalist Newspaper',
    description: 'Black-and-white brutalist newspaper layout with heavy serif and grids.',
    style_guidance:
      "Vintage front-page newspaper: off-white paper background (#F4F1E8) with subtle noise, massive black slab-serif headlines (font-weight 900) stretched wide, multi-column narrow serif body text divided by thin black rules. Halftone-dot circular 'photo' built from radial gradients. One red ink-stamp badge rotated 12°. Animations are abrupt snap-into-place, never smooth fades.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/12_brutalist_newspaper.mp4',
    order_index: 12,
    is_active: true,
  },
  {
    slug: 'flat_explainer',
    display_name: 'Flat Explainer',
    description: 'Flat illustration explainer style with friendly characters and color shapes.',
    style_guidance:
      "Friendly flat-illustration explainer on a soft pastel background (#FFF6E5 cream or #E8F4F8 pale blue). Simple geometric shapes — circles, rounded rectangles — in a warm palette (sunny yellow, turquoise, coral, indigo). Characters and abstract figures animate with bouncy spring physics. Rounded geometric sans typography (Quicksand/Nunito); slight tilts and soft drop shadows keep things organic, never sterile.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/13_flat_explainer.mp4',
    order_index: 13,
    is_active: true,
  },
  {
    slug: 'swiss_minimal',
    display_name: 'Swiss Minimal',
    description: 'Swiss-style minimal grid: Helvetica, large numerals, generous whitespace.',
    style_guidance:
      "International Typographic Style: pure white background (#FFFFFF), massive Helvetica-style numerals filling 60% of the viewport height in pure black. One thin red horizontal rule animates across, asymmetric grid layout, generous negative space (40%+ empty). Tiny tracked-out uppercase captions. Motion is restrained ease-out slides only — confident gallery-poster quality.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/14_swiss_minimal.mp4',
    order_index: 14,
    is_active: true,
  },
  {
    slug: 'corporate_data',
    display_name: 'Corporate Data',
    description: 'Polished corporate dashboards with KPIs, charts, and brand-safe colors.',
    style_guidance:
      "Polished corporate-dashboard look on an off-white background (#F8FAFC) with a calm brand-safe palette (navy primary, emerald positive, red warning, slate text). KPI cards with large numbers counting up, smooth bar/line charts growing, subtle status badges. Professional geometric sans typography (Inter/SF Pro), 1px borders and soft card shadows, 8px border-radius. Animations are smooth and measured — confidence over flash.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/15_corporate_data.mp4',
    order_index: 15,
    is_active: true,
  },
  {
    slug: 'holographic_glitch',
    display_name: 'Holographic Glitch',
    description: 'Holographic, neon, RGB-glitch aesthetic with scanlines and chromatic aberration.',
    style_guidance:
      "Cyberpunk holographic HUD: pure black background, cyan (#00F5FF) wireframe rectangles and brackets framing the screen with corner ticks. Monospace cyan text with RGB-split chromatic aberration (three offset copies in red/green/blue), random horizontal glitch bars flashing for a few frames, scanline overlay. Rotating wireframe globes and data readouts. Sci-fi tactical energy.",
    composition_id: 'Clip',
    example_video_path: 'motion_graphics_style/16_holographic_glitch.mp4',
    order_index: 16,
    is_active: true,
  },
];

/** Map: slug -> config */
export const MG_STYLE_BY_SLUG: Record<string, MGStyleConfig> = Object.fromEntries(
  MG_STYLES.map((s) => [s.slug, s]),
);

/** Map: composition_id -> config (legacy lookup). */
export const MG_STYLE_BY_COMPOSITION: Record<string, MGStyleConfig> = Object.fromEntries(
  MG_STYLES.map((s) => [s.composition_id, s]),
);

/** Default style for new groups (matches first active style). */
export const MG_DEFAULT_STYLE_SLUG = 'cinematic_dark';

/** Default clip duration in seconds (300 frames @ 30fps). */
export const MG_DEFAULT_CLIP_SECONDS = 16;

/**
 * Resolve the style_guidance text to send to the codegen worker.
 * - If the caller provided a custom override (free-text), use that.
 * - Otherwise pick the preset's long-form style_guidance.
 * - Fall back to description, then empty string.
 */
export function resolveStyleGuidance(
  slug: string | null | undefined,
  override?: string | null,
): string {
  if (override && override.trim()) return override.trim();
  if (!slug) return '';
  const entry = MG_STYLE_BY_SLUG[slug];
  if (!entry) return '';
  return entry.style_guidance || entry.description || '';
}
