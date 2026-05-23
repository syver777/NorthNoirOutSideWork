# Motion Graphics Inspiration — Example Prompts

These are real, high-quality prompts that have produced excellent motion graphics with
Remotion + AI. Use them as a creative reference for the _style_, _ambition_, and
_level of detail_ expected — NOT as templates to copy verbatim. Each example
illustrates a different visual technique you can borrow from.

---

## Example 1 — OCR + 3D paper article (highlighter reveal)

> Use Remotion best practices. Import a screenshot/article image. Pad it generously on a
> white full-HD background. Over 5 seconds, slowly and very subtly zoom in and rotate the
> article ~15° on each axis (left-to-right 3D tilt). At the start, blur the whole
> composition and unblur it over 1 second. After the blur clears, evolve a highlighter
> stroke from left to right (rough.js style) over the key phrases. The marker must
> appear behind the text. Use white background.

**Techniques:** subtle 3D transform, defocus reveal, rough hand-drawn highlighter on real text.

---

## Example 2 — Travel route on a map with 3D landmarks

> Make a new composition: load a map and zoom out of LA while staying focused on it.
> Once done, animate a line drawing from LA → NY and have the camera follow it. Add
> another stop in Paris. Animate the Eiffel Tower in 3D.

**Techniques:** map base layer, animated line draw, camera follow, 3D landmark.

---

## Example 3 — Cinematic CEO introduction (cyberpunk)

> 1920×1080, 30fps. Cinematic CEO intro. Clean white background with subtle radial noise
> texture. Massive centered name in a bold display font (NVIDIA-green #76B900) with a
> dramatic pop-in (scale 3× → 1×). At frame 40, introduce a cutout PNG of the person on
> the right side with explosive spring entrance, continuous floating motion, and
> occasional digital glitch (skew + hue-rotate). Layer above rotating dashed tech rings
> and falling Matrix-style data streams. Slide in a glassmorphism HUD panel from the
> left (dark semi-transparent green, cut-corner clip-path) showing title + bio in
> monospace. Add a vertical green scanner line, animated corner brackets, and floating
> geometric particles (triangles/hexagons). Use spring + interpolate for all transitions.

**Techniques:** dramatic typography pop, cutout PNG with glitch, glassmorphism HUD,
particles, scanner overlay, mixed-media layering.

---

## Example 4 — 3D bar tower data visualization (top-N ranking)

> Create a Remotion + React-Three-Fiber 3D visualization of the top 20 X by Y. Use
> boxes as towers with height representing the value. Animate the camera from the
> bottom of rank #20 up to the top of rank #1, pausing for a few hundred ms on each
> rank. 1920×1080, 60fps.

**Techniques:** 3D tower bars, camera path, pause-on-data-point storytelling.

---

## Example 5 — Audio spectrum visualizer

> 1920×1080 dark composition. Audio spectrum visualizer synced to a track: 32 vertical
> frequency bars that bounce reactively to bass/mids/highs. Vibrant gradient from
> magenta to cyan across the bars. Each bar has a subtle glow and smooth rounded tops.
> Bars reflect faintly on a glossy dark surface below. Centered horizontally, gentle
> padding. Whole visualization fades in smoothly. Duration matches the audio length.

**Techniques:** audio-reactive bars, gradient color across set, glow + reflection,
bouncy spring physics.

---

## Example 6 — Solar system with real astronomy data

> 1920×1080, 30fps, 30 seconds. One full year of planetary motion. Dark space background
> (#08090d) with 500 deterministic stars. Sun at center with radial gradient core +
> halo. 8 planets orbiting with real J2000 mean longitudes. Faint orbit rings. Each
> planet is a radial-gradient circle with same-color glow. Saturn has a tilted ring
> ellipse. Earth has a moon (27.32-day period). Inner planets linear-scaled, outer
> planets log-compressed so all stay in frame. Title always visible at top, current
> simulated date in a frosted-glass pill at bottom. Use Canvas 2D for the scene; HTML
> overlays for text.

**Techniques:** Canvas-2D drawing, deterministic randomness, real data, multi-scale
visualization, persistent overlays, frosted-glass UI.

---

## Example 7 — CRT terminal effect

> Subtle CRT convex-shape shader on top of an HTML element. Content: terminal showing
> the command and output of `npx create-video@latest --yes --blank my-video`, animated
> typewriter. Then "claude" is invoked and the prompt "Add a CRT effect using
> HTML-in-canvas" is shown.

**Techniques:** HTML-in-canvas with shader pass, typewriter animation, terminal
aesthetic.

---

## Example 8 — News headline highlight

> Take a news article headline. Layout it as if printed on a clean light background.
> Animate a yellow highlighter stroke (rough hand-drawn style) sweeping across the key
> phrases word by word. Camera does a slow subtle push-in.

**Techniques:** typography-first design, hand-drawn highlight, subtle push-in.

---

## Common patterns to borrow

- **Reveal techniques**: blur→sharp, scale 3×→1× pop, slide-from-edge, line-draw,
  highlighter sweep, type-on, fade+rise.
- **Background treatments**: subtle radial noise, frosted-glass panels, dark
  near-black with neon accents, white with very subtle texture.
- **Layered depth**: foreground subject + mid-layer HUD/panel + background particles +
  scanner/grid overlay.
- **Continuous micro-motion**: floating, breathing, rotating dashed rings, drifting
  particles — keeps frames alive between major events.
- **Glitch / distortion**: occasional skew, hue-rotate, RGB-split for dramatic
  emphasis — used sparingly.
- **Real assets**: actual photos of people/places/products dramatically raise
  perceived production value vs. abstract shapes alone.
- **Persistent UI**: title and key info stay visible; only data/figures animate
  in/out.

When designing a prompt for a story segment, ask: _which of these techniques
serves THIS content?_ Don't pile them all on. Pick 2-3 that match the message.
