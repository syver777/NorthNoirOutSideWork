"""Subtitle generation + burn-in helper for the create-final-video* GCFs.

Ported from SSAIVidGen2.py. Public entry point:

    maybe_burn_subtitles(
        supabase, video_task_id, final_video_path, temp_dir,
        suppress_spans=None,
    ) -> bool

Returns True if subtitles were burned (final_video_path replaced in-place),
False if no subtitles were configured or the burn failed.

The function:
  1. Loads `subtitles` jsonb from the video_tasks row.
  2. If NULL → returns False immediately (preserves prior behavior).
  3. Extracts the audio track from the already-rendered final video.
  4. Uploads it to fal-ai/whisper to get word-level timestamps.
  5. Builds an .ass file styled per the config + burns it into the video,
     replacing final_video_path on success.

Fonts are loaded from a `fonts/` directory shipped alongside this module
in the deployed GCF (see gcloudfunctions/fonts/).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from typing import Dict, List, Optional, Sequence, Tuple

try:
    import fal_client  # provided by the GCF requirements (fal-client>=0.7.0)
except Exception:  # pragma: no cover
    fal_client = None  # type: ignore


# ──────────────────────────────────────────────────────────────
# SUBTITLE STYLE TABLES (mirror SSAIVidGen2.py)
# ──────────────────────────────────────────────────────────────

SUBTITLE_FONTS = [
    "Montserrat",          # 1
    "Bebas Neue",          # 2
    "Anton",               # 3
    "Montserrat Black",    # 4  (default)
    "Poppins",             # 5
    "Oswald",              # 6
    "Lobster",             # 7
    "Permanent Marker",    # 8
    "Bangers",             # 9
    "Oswald Bold",         # 10
]

# ASS color format is &HAABBGGRR (alpha + BGR). 00 alpha = fully opaque.
SUBTITLE_COLOR_PRESETS = [
    {"name": "classic_white",   "primary": "&H00FFFFFF", "outline": "&H00000000",
        "back": "&H64000000", "border": 1, "outline_w": 3, "shadow": 0},
    {"name": "cinema_yellow",   "primary": "&H0000F0FF", "outline": "&H00000000",
        "back": "&H64000000", "border": 1, "outline_w": 3, "shadow": 0},
    {"name": "clean_shadow",    "primary": "&H00FFFFFF", "outline": "&H00000000",
        "back": "&HC8000000", "border": 1, "outline_w": 1, "shadow": 3},
    {"name": "black_on_white",  "primary": "&H00000000", "outline": "&H00FFFFFF",
        "back": "&H00FFFFFF", "border": 3, "outline_w": 4, "shadow": 0},
    {"name": "box_caption",     "primary": "&H00FFFFFF", "outline": "&H78000000",
        "back": "&H78000000", "border": 3, "outline_w": 8, "shadow": 0},
    {"name": "synthwave",       "primary": "&H00FFFF00", "outline": "&H00660033",
        "back": "&H64000000", "border": 1, "outline_w": 2, "shadow": 0},
    {"name": "gold_premium",    "primary": "&H0000C8FF", "outline": "&H00003366",
        "back": "&H64000000", "border": 1, "outline_w": 3, "shadow": 1},
    {"name": "urgent_red",      "primary": "&H000000FF", "outline": "&H00FFFFFF",
        "back": "&H64000000", "border": 1, "outline_w": 4, "shadow": 0},
    {"name": "gradient_sunset", "primary": "&H0000F0FF", "outline": "&H000080FF",
        "back": "&H64000000", "border": 1, "outline_w": 6, "shadow": 1},
    {"name": "classic_black",   "primary": "&H00000000", "outline": "&H00FFFFFF",
        "back": "&H64000000", "border": 1, "outline_w": 3, "shadow": 0},
]

SUBTITLE_SIZES = [32, 40, 48, 56, 64, 72, 84, 96, 112, 128]

SUBTITLE_MODES = ["phrase", "karaoke", "single_word"]

VALID_POSITIONS = {"bottom", "center", "top"}


# ──────────────────────────────────────────────────────────────
# ASS FILE BUILDERS
# ──────────────────────────────────────────────────────────────

def _ass_time(t: float) -> str:
    if t < 0:
        t = 0.0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t - h * 3600 - m * 60
    cs = int(round((s - int(s)) * 100))
    s_int = int(s)
    if cs >= 100:
        cs = 0
        s_int += 1
    return f"{h}:{m:02d}:{s_int:02d}.{cs:02d}"


def _ass_escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
            .replace("{", "\\{")
            .replace("}", "\\}")
            .replace("\n", "\\N")
    )


def _group_words_into_cues(word_timestamps, mode="phrase",
                           min_words=3, max_words=7, max_gap=0.55,
                           max_cue_duration=4.5):
    cues: List[Dict] = []
    if not word_timestamps:
        return cues

    if mode == "single_word":
        for w in word_timestamps:
            if not w.get('word'):
                continue
            cues.append({
                'start': w['start'],
                'end': max(w['end'], w['start'] + 0.18),
                'words': [w],
            })
        return cues

    current: List[Dict] = []
    current_start: Optional[float] = None
    sentence_end_re = re.compile(r'[\.!?]$')
    for i, w in enumerate(word_timestamps):
        if not w.get('word'):
            continue
        if current_start is None:
            current_start = w['start']
        current.append(w)

        next_w = word_timestamps[i + 1] if i + \
            1 < len(word_timestamps) else None
        gap = (next_w['start'] - w['end']) if next_w else 99.0
        cue_dur = w['end'] - current_start
        ends_sentence = bool(sentence_end_re.search(w['word'].strip()))

        should_break = (
            len(current) >= max_words or
            (len(current) >= min_words and (gap > max_gap or ends_sentence)) or
            cue_dur >= max_cue_duration or
            next_w is None
        )
        if should_break:
            cues.append({
                'start': current_start,
                'end': w['end'],
                'words': current,
            })
            current = []
            current_start = None
    return cues


def _build_dialogue_text(cue, mode):
    if mode == "karaoke":
        parts = []
        for w in cue['words']:
            dur_cs = max(1, int(round((w['end'] - w['start']) * 100)))
            parts.append(f"{{\\kf{dur_cs}}}{_ass_escape(w['word'])}")
        return " ".join(parts)
    return _ass_escape(" ".join(w['word'] for w in cue['words']))


def generate_ass_subtitles(word_timestamps, output_path,
                           video_width=1920, video_height=1080,
                           font_idx=4, color_idx=1, size_idx=4,
                           mode="phrase", position="bottom",
                           suppress_spans: Optional[Sequence[Tuple[float, float]]] = None):
    font = SUBTITLE_FONTS[(font_idx - 1) % len(SUBTITLE_FONTS)]
    preset = SUBTITLE_COLOR_PRESETS[(
        color_idx - 1) % len(SUBTITLE_COLOR_PRESETS)]
    base_size = SUBTITLE_SIZES[(size_idx - 1) % len(SUBTITLE_SIZES)]
    fontsize = max(16, int(round(base_size * (video_height / 1080.0))))

    alignment = {"bottom": 2, "center": 5, "top": 8}.get(position, 2)
    margin_v = max(40, int(video_height * 0.06))

    secondary = "&H000000FF"

    style_line = (
        f"Style: Default,{font},{fontsize},"
        f"{preset['primary']},{secondary},{preset['outline']},{preset['back']},"
        f"-1,0,0,0,100,100,0,0,"
        f"{preset['border']},{preset['outline_w']},{preset['shadow']},"
        f"{alignment},60,60,{margin_v},1"
    )

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{style_line}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    cues = _group_words_into_cues(word_timestamps, mode=mode)

    def _in_suppress(t):
        if not suppress_spans:
            return False
        for a, b in suppress_spans:
            if a <= t <= b:
                return True
        return False

    lines = []
    for cue in cues:
        mid = (cue['start'] + cue['end']) / 2
        if _in_suppress(mid):
            continue
        text = _build_dialogue_text(cue, mode)
        if not text.strip():
            continue
        text = "{\\fad(80,80)}" + text
        lines.append(
            f"Dialogue: 0,{_ass_time(cue['start'])},{_ass_time(cue['end'])},"
            f"Default,,0,0,0,,{text}"
        )

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(header)
        f.write("\n".join(lines))
        f.write("\n")

    print(f"[subtitles] Wrote {len(lines)} cues -> {output_path}")
    return output_path


# ──────────────────────────────────────────────────────────────
# FFMPEG HELPERS
# ──────────────────────────────────────────────────────────────

_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_ffmpeg(name: str) -> str:
    """Use the local ffmpeg/ffprobe binary if present (matches sibling GCFs), else PATH."""
    local = os.path.join(os.getcwd(), name)
    if os.path.exists(local):
        return local
    return name


def _probe_video_resolution(video_path: str) -> Tuple[int, int]:
    try:
        probe = subprocess.run(
            [_resolve_ffmpeg('ffprobe'), '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=width,height',
             '-of', 'csv=s=x:p=0', video_path],
            capture_output=True, text=True, check=True
        )
        parts = probe.stdout.strip().split('x')
        if len(parts) == 2:
            return int(parts[0]), int(parts[1])
    except Exception:
        pass
    return 1920, 1080


def _extract_audio_track(video_path: str, out_wav: str) -> bool:
    """Pull the audio track out of the rendered video as 16k mono WAV for Whisper."""
    try:
        subprocess.run(
            [_resolve_ffmpeg('ffmpeg'), '-y', '-i', video_path,
             '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', out_wav],
            check=True, capture_output=True,
        )
        return os.path.exists(out_wav) and os.path.getsize(out_wav) > 1000
    except Exception as e:
        print(f"[subtitles] audio extraction failed: {e}")
        return False


def _whisper_word_timestamps(audio_path: str, language: str = "en") -> List[Dict]:
    """Upload local audio to fal and call fal-ai/whisper with chunk_level=word."""
    if fal_client is None:
        print("[subtitles] fal_client not available")
        return []
    try:
        audio_url = fal_client.upload_file(audio_path)
    except Exception as e:
        print(f"[subtitles] fal upload failed: {e}")
        return []
    try:
        result = fal_client.subscribe(
            "fal-ai/whisper",
            arguments={
                "audio_url": audio_url,
                "task": "transcribe",
                "language": language,
                "chunk_level": "word",
                "version": "3",
                "batch_size": 64,
                "diarize": False,
                "num_speakers": None,
                "prompt": "",
            },
            with_logs=False,
        )
    except Exception as e:
        print(f"[subtitles] fal whisper failed: {e}")
        return []

    words: List[Dict] = []
    for chunk in result.get('chunks', []) or []:
        ts = chunk.get('timestamp') or [None, None]
        if ts[0] is None or ts[1] is None:
            continue
        word = (chunk.get('text') or '').strip()
        if not word:
            continue
        words.append(
            {'word': word, 'start': float(ts[0]), 'end': float(ts[1])})
    print(f"[subtitles] whisper produced {len(words)} word timestamps")
    return words


def _burn_subtitles(video_path: str, ass_path: str, output_path: str) -> bool:
    """Burn ASS file into video with libass. Looks for fonts in:
       1) <ass_dir>/fonts (so callers may stage fonts next to the .ass), then
       2) the deployed module's bundled fonts/ folder (gcloudfunctions/fonts/).
    """
    ass_dir = os.path.dirname(os.path.abspath(ass_path)) or "."
    ass_name = os.path.basename(ass_path)

    fontsdir_arg = ""
    local_fonts = os.path.join(ass_dir, "fonts")
    bundled_fonts = os.path.join(_MODULE_DIR, "fonts")
    if os.path.isdir(local_fonts):
        fontsdir_arg = ":fontsdir=fonts"
    elif os.path.isdir(bundled_fonts):
        # libass needs an absolute or filter-escaped path; use abspath to be safe.
        fontsdir_arg = f":fontsdir={bundled_fonts}"

    vf = f"ass={ass_name}{fontsdir_arg}"
    cmd = [
        _resolve_ffmpeg('ffmpeg'), '-y', '-i', os.path.abspath(video_path),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        os.path.abspath(output_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, cwd=ass_dir)
        return True
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors='replace') if e.stderr else str(e)
        print(f"[subtitles] burn failed: {err[-1200:]}")
        return False


# ──────────────────────────────────────────────────────────────
# CONFIG VALIDATION
# ──────────────────────────────────────────────────────────────

def _normalize_config(cfg) -> Optional[Dict]:
    if cfg is None:
        return None
    if not isinstance(cfg, dict):
        print(f"[subtitles] ignored non-dict subtitles config: {type(cfg)}")
        return None

    def _clamp(v, lo, hi, default):
        try:
            iv = int(v)
        except (TypeError, ValueError):
            return default
        if iv < lo or iv > hi:
            return default
        return iv

    mode = cfg.get('mode', 'phrase')
    if mode not in SUBTITLE_MODES:
        mode = 'phrase'
    position = cfg.get('position', 'bottom')
    if position not in VALID_POSITIONS:
        position = 'bottom'

    return {
        'font_idx': _clamp(cfg.get('font_idx', 4), 1, len(SUBTITLE_FONTS), 4),
        'color_idx': _clamp(cfg.get('color_idx', 1), 1, len(SUBTITLE_COLOR_PRESETS), 1),
        'size_idx': _clamp(cfg.get('size_idx', 5), 1, len(SUBTITLE_SIZES), 5),
        'mode': mode,
        'position': position,
    }


def _stage_local_fonts(work_dir: str) -> None:
    """Copy bundled fonts/ next to the .ass file so libass picks them up reliably."""
    bundled = os.path.join(_MODULE_DIR, "fonts")
    if not os.path.isdir(bundled):
        return
    dest = os.path.join(work_dir, "fonts")
    if os.path.isdir(dest):
        return
    try:
        shutil.copytree(bundled, dest)
    except Exception as e:
        print(f"[subtitles] could not stage fonts: {e}")


# ──────────────────────────────────────────────────────────────
# PUBLIC ENTRY POINT
# ──────────────────────────────────────────────────────────────

def maybe_burn_subtitles(
    supabase,
    video_task_id: str,
    final_video_path: str,
    temp_dir: str,
    suppress_spans: Optional[Sequence[Tuple[float, float]]] = None,
    language: str = "en",
) -> bool:
    """Conditionally burn subtitles into final_video_path (in place).

    Returns True if subtitles were burned, False otherwise (no-op preserves
    existing pipeline behavior exactly).
    """
    if not video_task_id or not final_video_path or not os.path.exists(final_video_path):
        return False

    # 1. Read subtitles config + cached narration word timestamps from the row.
    cached_words: List[Dict] = []
    try:
        row = supabase.table('video_tasks').select(
            'subtitles, narration_word_timestamps, narration_word_timestamps_path'
        ).eq('id', video_task_id).single().execute()
        row_data = (row.data or {}) if row else {}
        cfg_raw = row_data.get('subtitles')
        raw_words = row_data.get('narration_word_timestamps') or []

        # Fallback: large videos stash the timestamps as a gzipped JSON file
        # in the `stories` bucket. Download + decompress when the inline
        # column is empty but a path is set.
        if not raw_words:
            raw_path = row_data.get('narration_word_timestamps_path')
            if raw_path:
                try:
                    import gzip as _gzip
                    import json as _json
                    # Stored as "stories/<path>" — strip the bucket prefix.
                    bucket_prefix = 'stories/'
                    obj_path = raw_path[len(bucket_prefix):] if raw_path.startswith(
                        bucket_prefix) else raw_path
                    print(
                        f"[subtitles] downloading narration_word_timestamps from stories/{obj_path}")
                    gz_bytes = supabase.storage.from_(
                        'stories').download(obj_path)
                    decompressed = _gzip.decompress(gz_bytes)
                    loaded = _json.loads(decompressed.decode('utf-8'))
                    if isinstance(loaded, list):
                        raw_words = loaded
                        print(
                            f"[subtitles] loaded {len(raw_words)} word timestamps from file")
                except Exception as _se:
                    print(
                        f"[subtitles] failed to download word timestamps file: {_se}")

        if isinstance(raw_words, list):
            for w in raw_words:
                if not isinstance(w, dict):
                    continue
                try:
                    cached_words.append({
                        'word': str(w.get('word', '')).strip(),
                        'start': float(w.get('start', 0.0)),
                        'end': float(w.get('end', 0.0)),
                    })
                except (TypeError, ValueError):
                    continue
    except Exception as e:
        print(f"[subtitles] could not load subtitles config: {e}")
        return False

    cfg = _normalize_config(cfg_raw)
    if not cfg:
        return False

    print(f"[subtitles] burning subtitles for task {video_task_id}: {cfg}")

    work_dir = temp_dir or os.path.dirname(final_video_path) or "."
    os.makedirs(work_dir, exist_ok=True)
    audio_wav: Optional[str] = None

    try:
        # 2. Prefer cached narration word timestamps from calculate-video-durations.
        if cached_words:
            print(
                f"[subtitles] using {len(cached_words)} cached narration word timestamps "
                f"(skipping second Whisper call)")
            words = cached_words
        else:
            # Fallback: extract audio from the final video and run Whisper.
            print(
                "[subtitles] no cached word timestamps found; running Whisper on final video audio")
            audio_wav = os.path.join(work_dir, f"subs_{video_task_id}.wav")
            if not _extract_audio_track(final_video_path, audio_wav):
                return False
            words = _whisper_word_timestamps(audio_wav, language=language)
            if not words:
                print("[subtitles] no word timestamps from whisper, skipping burn")
                return False

        # 4. Generate .ass.
        _stage_local_fonts(work_dir)
        vw, vh = _probe_video_resolution(final_video_path)
        ass_path = os.path.join(work_dir, f"subs_{video_task_id}.ass")
        generate_ass_subtitles(
            words, ass_path,
            video_width=vw, video_height=vh,
            font_idx=cfg['font_idx'],
            color_idx=cfg['color_idx'],
            size_idx=cfg['size_idx'],
            mode=cfg['mode'],
            position=cfg['position'],
            suppress_spans=suppress_spans,
        )

        # 5. Burn into video, replace original on success.
        tmp_out = os.path.join(work_dir, f"subs_out_{video_task_id}.mp4")
        if not _burn_subtitles(final_video_path, ass_path, tmp_out):
            return False
        try:
            os.replace(tmp_out, final_video_path)
        except OSError as e:
            print(f"[subtitles] failed replacing final video: {e}")
            return False
        print(f"[subtitles] subtitles burned into {final_video_path}")
        return True
    finally:
        if audio_wav:
            try:
                if os.path.exists(audio_wav):
                    os.remove(audio_wav)
            except OSError:
                pass


# ──────────────────────────────────────────────────────────────
# CHUNKED BURN PIPELINE
# ──────────────────────────────────────────────────────────────
# Long videos (>~1 h) cannot be re-encoded with libx264 inside one
# Cloud Functions invocation: the 60-min HTTP ceiling kills the call
# and /tmp (RAM-backed) cannot fit two ~5 GB MP4s simultaneously.
#
# The chunked pipeline splits the work into N invocations:
#   1. plan_subtitle_chunks(words, duration)  → list of (start,end)
#      bounded by ~target_chunk_sec, snapped to the largest inter-word
#      gap inside ±snap_window_pct of target so we never cut mid-word
#      and prefer natural sentence pauses.
#   2. burn_subtitle_chunk(...)               → per-chunk burn:
#      • copy-cut the source segment with `-c copy`     (no re-encode)
#      • generate chunk-scoped .ass (cues clipped to [start,end],
#        timestamps re-zeroed to the chunk start)
#      • libx264 burn → seg_<i>.mp4
#   3. The dispatcher in create-final-video.py downloads the source
#      once, calls burn_subtitle_chunk for the requested index, uploads
#      seg_<i>.mp4 to <chunks_path>, then triggers the next chunk via
#      the same edge function.
#   4. The final concat invocation (concat_chunks=true) downloads all
#      seg_<i>.mp4, runs the concat demuxer with `-c copy`, replaces
#      final_video_url, then promotes subtitle_tokens_pending into
#      subtitle_tokens (single trigger fire → user_plans bump).


def _video_duration(video_path: str) -> float:
    """Probe duration in seconds. Returns 0.0 on failure."""
    try:
        probe = subprocess.run(
            [_resolve_ffmpeg('ffprobe'), '-v', 'error',
             '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', video_path],
            capture_output=True, text=True, check=True,
        )
        return float((probe.stdout or '0').strip() or 0.0)
    except Exception as e:
        print(f"[subtitles] duration probe failed: {e}")
        return 0.0


def plan_subtitle_chunks(
    word_timestamps: List[Dict],
    video_duration_sec: float,
    target_chunk_sec: float = 2400.0,
    min_chunk_sec: float = 600.0,
    snap_window_pct: float = 0.20,
) -> List[Dict]:
    """Split a long video into ~target_chunk_sec chunks at natural pauses.

    Returns a list of dicts: ``[{"i":0,"start":0.0,"end":2403.5}, ...]``
    sorted by index. Boundaries snap to the largest inter-word gap inside
    ``[target ± target*snap_window_pct]`` so we never cut mid-word and
    prefer sentence-end pauses. Final chunk absorbs everything past the
    last boundary (so the tail is never below min_chunk_sec).
    """
    if video_duration_sec <= target_chunk_sec * 1.10:
        return [{"i": 0, "start": 0.0, "end": float(video_duration_sec)}]

    # Sort + filter words to only those with valid times.
    words = [w for w in (word_timestamps or [])
             if isinstance(w, dict)
             and isinstance(w.get('start'), (int, float))
             and isinstance(w.get('end'), (int, float))
             and w['end'] >= w['start']]
    words.sort(key=lambda w: w['start'])

    boundaries: List[float] = []
    cursor = 0.0
    while cursor + target_chunk_sec + min_chunk_sec < video_duration_sec:
        target = cursor + target_chunk_sec
        win_lo = max(cursor + min_chunk_sec, target -
                     target_chunk_sec * snap_window_pct)
        win_hi = min(video_duration_sec - min_chunk_sec,
                     target + target_chunk_sec * snap_window_pct)
        if win_hi <= win_lo:
            boundaries.append(target)
            cursor = target
            continue

        # Find the largest inter-word gap whose midpoint sits in the window.
        best_gap = -1.0
        best_mid = target
        for i in range(len(words) - 1):
            a_end = words[i]['end']
            b_start = words[i + 1]['start']
            if b_start < win_lo:
                continue
            if a_end > win_hi:
                break
            mid = (a_end + b_start) / 2.0
            if not (win_lo <= mid <= win_hi):
                continue
            gap = b_start - a_end
            if gap > best_gap:
                best_gap = gap
                best_mid = mid
        boundaries.append(best_mid)
        cursor = best_mid

    plan: List[Dict] = []
    prev = 0.0
    for idx, b in enumerate(boundaries):
        plan.append({"i": idx, "start": float(prev), "end": float(b)})
        prev = b
    plan.append({"i": len(boundaries), "start": float(prev),
                 "end": float(video_duration_sec)})
    return plan


def _copy_cut_segment(src_video: str, start: float, end: float, dst: str) -> bool:
    """Copy-cut [start,end] of src_video to dst. No re-encode."""
    try:
        cmd = [_resolve_ffmpeg('ffmpeg'), '-y',
               '-ss', f"{start:.3f}",
               '-to', f"{end:.3f}",
               '-i', src_video,
               '-c', 'copy',
               '-avoid_negative_ts', 'make_zero',
               '-movflags', '+faststart',
               dst]
        subprocess.run(cmd, check=True, capture_output=True)
        return os.path.exists(dst) and os.path.getsize(dst) > 0
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors='replace') if e.stderr else str(e)
        print(f"[subtitles] copy-cut failed: {err[-1200:]}")
        return False


def _clip_words_to_window(word_timestamps: List[Dict],
                          start: float, end: float) -> List[Dict]:
    """Return words whose midpoint falls inside [start,end], with timestamps
    re-zeroed to the chunk start. Words straddling a boundary are clipped to
    the chunk edges."""
    out: List[Dict] = []
    for w in word_timestamps or []:
        ws = float(w.get('start', 0.0))
        we = float(w.get('end', ws))
        mid = (ws + we) / 2.0
        if mid < start or mid >= end:
            continue
        out.append({
            'word': w.get('word', ''),
            'start': max(0.0, ws - start),
            'end':   max(0.0, min(we, end) - start),
        })
    return out


def burn_subtitle_chunk(
    src_video_path: str,
    word_timestamps: List[Dict],
    chunk: Dict,
    cfg: Dict,
    work_dir: str,
    suppress_spans: Optional[Sequence[Tuple[float, float]]] = None,
) -> Optional[str]:
    """Burn one chunk of src_video. Returns local path to seg_<i>.mp4 or None.

    Steps:
      1. copy-cut [chunk.start, chunk.end] → seg_<i>_raw.mp4 (no re-encode)
      2. generate chunk-scoped .ass with re-zeroed timestamps
      3. libx264 burn → seg_<i>.mp4 (deletes the raw cut to free /tmp)
    """
    idx = int(chunk.get('i', 0))
    start = float(chunk.get('start', 0.0))
    end = float(chunk.get('end', start))
    if end <= start:
        print(f"[subtitles] invalid chunk window {start}..{end}")
        return None

    os.makedirs(work_dir, exist_ok=True)
    raw_seg = os.path.join(work_dir, f"seg_{idx}_raw.mp4")

    if not _copy_cut_segment(src_video_path, start, end, raw_seg):
        return None
    try:
        return burn_subtitle_chunk_from_raw(
            raw_seg, word_timestamps, chunk, cfg, work_dir,
            suppress_spans=suppress_spans,
        )
    finally:
        try:
            if os.path.exists(raw_seg):
                os.remove(raw_seg)
        except OSError:
            pass


def burn_subtitle_chunk_from_raw(
    raw_seg_path: str,
    word_timestamps: List[Dict],
    chunk: Dict,
    cfg: Dict,
    work_dir: str,
    suppress_spans: Optional[Sequence[Tuple[float, float]]] = None,
) -> Optional[str]:
    """Same as ``burn_subtitle_chunk`` but the input is an already-cut
    segment (typically downloaded from storage). Skips the copy-cut step,
    so the per-chunk Cloud Function invocation only has to download its
    own ~400 MB slice instead of the full ~5 GB final video.

    The .ass file's timestamps are re-zeroed to ``chunk.start`` exactly
    like ``burn_subtitle_chunk`` so the rendered cues line up with the
    pre-cut content.
    """
    idx = int(chunk.get('i', 0))
    start = float(chunk.get('start', 0.0))
    end = float(chunk.get('end', start))
    if end <= start:
        print(f"[subtitles] invalid chunk window {start}..{end}")
        return None

    os.makedirs(work_dir, exist_ok=True)
    ass_path = os.path.join(work_dir, f"seg_{idx}.ass")
    out_seg = os.path.join(work_dir, f"seg_{idx}.mp4")

    _stage_local_fonts(work_dir)
    vw, vh = _probe_video_resolution(raw_seg_path)
    chunk_words = _clip_words_to_window(word_timestamps, start, end)
    local_suppress: Optional[List[Tuple[float, float]]] = None
    if suppress_spans:
        local_suppress = []
        for a, b in suppress_spans:
            la = max(0.0, float(a) - start)
            lb = max(0.0, min(float(b), end) - start)
            if lb > la:
                local_suppress.append((la, lb))

    generate_ass_subtitles(
        chunk_words, ass_path,
        video_width=vw, video_height=vh,
        font_idx=cfg['font_idx'],
        color_idx=cfg['color_idx'],
        size_idx=cfg['size_idx'],
        mode=cfg['mode'],
        position=cfg['position'],
        suppress_spans=local_suppress,
    )
    if not _burn_subtitles(raw_seg_path, ass_path, out_seg):
        return None
    return out_seg


def concat_burned_chunks(seg_paths: List[str], dst_path: str) -> bool:
    """Concat demuxer with `-c copy`. All seg_*.mp4 share encoder params
    (libx264 from _burn_subtitles + AAC carried through), so copy is safe."""
    if not seg_paths:
        return False
    work_dir = os.path.dirname(os.path.abspath(dst_path)) or '.'
    list_path = os.path.join(work_dir, '_concat_list.txt')
    try:
        with open(list_path, 'w', encoding='utf-8') as f:
            for p in seg_paths:
                ap = os.path.abspath(p).replace("'", "'\\''")
                f.write(f"file '{ap}'\n")
        cmd = [_resolve_ffmpeg('ffmpeg'), '-y',
               '-f', 'concat', '-safe', '0',
               '-i', list_path,
               '-c', 'copy',
               '-movflags', '+faststart',
               dst_path]
        subprocess.run(cmd, check=True, capture_output=True)
        return os.path.exists(dst_path) and os.path.getsize(dst_path) > 0
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors='replace') if e.stderr else str(e)
        print(f"[subtitles] chunk concat failed: {err[-1200:]}")
        return False
    finally:
        try:
            if os.path.exists(list_path):
                os.remove(list_path)
        except OSError:
            pass


def load_word_timestamps_from_task(supabase, video_task_id: str) -> List[Dict]:
    """Read narration_word_timestamps from the row, falling back to the
    gzipped JSON in the `stories` bucket. Returns [] on any failure."""
    try:
        row = supabase.table('video_tasks').select(
            'narration_word_timestamps, narration_word_timestamps_path'
        ).eq('id', video_task_id).single().execute()
        row_data = (row.data or {}) if row else {}
    except Exception as e:
        print(f"[subtitles] load timestamps row failed: {e}")
        return []

    raw_words = row_data.get('narration_word_timestamps') or []
    if not raw_words:
        raw_path = row_data.get('narration_word_timestamps_path')
        if raw_path:
            try:
                import gzip as _gzip
                import json as _json
                bucket_prefix = 'stories/'
                obj_path = (raw_path[len(bucket_prefix):]
                            if raw_path.startswith(bucket_prefix) else raw_path)
                gz_bytes = supabase.storage.from_('stories').download(obj_path)
                loaded = _json.loads(
                    _gzip.decompress(gz_bytes).decode('utf-8'))
                if isinstance(loaded, list):
                    raw_words = loaded
            except Exception as e:
                print(f"[subtitles] timestamps file download failed: {e}")
                return []

    out: List[Dict] = []
    if isinstance(raw_words, list):
        for w in raw_words:
            if not isinstance(w, dict):
                continue
            try:
                out.append({
                    'word': str(w.get('word', '')).strip(),
                    'start': float(w.get('start', 0.0)),
                    'end': float(w.get('end', 0.0)),
                })
            except (TypeError, ValueError):
                continue
    return out


def get_subtitle_config(supabase, video_task_id: str) -> Optional[Dict]:
    """Read + normalize the subtitles config for a task."""
    try:
        row = supabase.table('video_tasks').select(
            'subtitles').eq('id', video_task_id).single().execute()
        cfg_raw = ((row.data or {}) if row else {}).get('subtitles')
    except Exception as e:
        print(f"[subtitles] load config failed: {e}")
        return None
    return _normalize_config(cfg_raw)
