import functions_framework
import json
import os
import subprocess
import tempfile
import uuid
import requests
from supabase import create_client, Client
import time
import re
import shutil
import unicodedata
import math  # ADDED: Import math for ceil function
# local module: gcloudfunctions/subtitles.py
from subtitles import (
    maybe_burn_subtitles,
    plan_subtitle_chunks,
    burn_subtitle_chunk,
    burn_subtitle_chunk_from_raw,
    concat_burned_chunks,
    load_word_timestamps_from_task,
    get_subtitle_config,
    _copy_cut_segment as _subs_copy_cut_segment,
    _video_duration as _probe_video_duration_secs,
)
from _billing import billed, add_billing_metadata, finalize_subtitle_tokens

# ── GCF version suffix ─────────────────────────────────────────────────────────
# Each create-final-video{N}.py sets this to its own suffix so that the
# high-memory delegation always targets the matching create-final-video-high-memory{N}.
_GCF_SUFFIX = '-high-memory'  # high-memory variant


ALLOWED_ORIGINS = [
    'https://storyscriptai.com',
    'https://www.storyscriptai.com',
    'https://northnoir.com',
    'https://www.northnoir.com',
    'http://localhost:5173',
]


def get_cors_origin(request):
    origin = request.headers.get('Origin', '')
    if origin in ALLOWED_ORIGINS:
        return origin
    return ALLOWED_ORIGINS[0]


def add_cors_headers(request, response_data, status_code=200):
    """Add CORS headers to response"""
    headers = {
        'Access-Control-Allow-Origin': get_cors_origin(request),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        'Access-Control-Max-Age': '3600'
    }
    return response_data, status_code, headers


def verify_service_role_key(request):
    """Verify request includes a valid Supabase opaque key.

    Accepts either `Authorization: Bearer <key>` OR `apikey: <key>` header.
    Validates against either SUPABASE_SECRET_KEY (server) or
    SUPABASE_PUBLIC_KEY (publishable). Same pattern as Deno Deploy.
    """
    expected_keys = [k for k in (
        os.getenv("SUPABASE_SECRET_KEY"),
        os.getenv("SUPABASE_PUBLIC_KEY"),
    ) if k]
    if not expected_keys:
        print("ERROR: SUPABASE_SECRET_KEY/SUPABASE_PUBLIC_KEY not set")
        return False

    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        token = auth_header[7:]
    else:
        token = request.headers.get('apikey', '')

    if token and token in expected_keys:
        return True

    print("ERROR: Invalid or missing key in Authorization/apikey header")
    return False


def check_user_token_balance(supabase, user_id, tokens_to_add):
    """Check if user has enough token balance and return safe amount to add"""
    try:
        # Get user's current token usage and allocation
        result = supabase.table("user_plans").select(
            "tokens_used, tokens_allocated, rollover_tokens").eq("user_id", user_id).single().execute()

        if not result.data:
            print(f"No user plan found for user {user_id}")
            return 0

        tokens_used = result.data.get("tokens_used", 0)
        tokens_allocated = result.data.get("tokens_allocated", 0)

        # Calculate how many tokens can safely be added without exceeding limit
        rollover_tokens = result.data.get("rollover_tokens", 0)
        available_tokens = tokens_allocated + rollover_tokens - tokens_used

        if available_tokens <= 0:
            print(
                f"Token limit already reached or exceeded: {tokens_used} / {tokens_allocated}")
            return 0

        # Return the safe amount to add (either full amount or up to limit)
        safe_amount = min(tokens_to_add, available_tokens)

        if safe_amount < tokens_to_add:
            print(
                f"Token limit would be exceeded: {tokens_used} + {tokens_to_add} > {tokens_allocated}")
            print(f"Adjusting to add only {safe_amount} tokens (up to limit)")
        else:
            print(
                f"Token check passed: {tokens_used} + {tokens_to_add} <= {tokens_allocated}")

        return safe_amount

    except Exception as e:
        print(f"Error checking token balance: {str(e)}")
        return 0


# ADDED: Helper function to calculate transition batch tokens
def calculate_transition_tokens(num_images, has_transitions, visual_type='image'):
    """Calculate tokens needed for video processing with transition support.

    ITV/TTV use batch_size=12 and 40k per additional batch.
    Images use batch_size=6 and 85k per additional batch.
    """
    base_tokens = 150000  # Base cost for video processing

    # Determine batch size and per-batch cost based on visual type
    if visual_type in ('ttv', 'itv'):
        batch_size = 12
        cost_per_batch = 40000
    else:
        batch_size = 6
        cost_per_batch = 85000

    if has_transitions and num_images > batch_size:
        total_batches = math.ceil(num_images / batch_size)
        additional_batches = total_batches - 1  # Exclude the base batch
        transition_tokens = additional_batches * cost_per_batch
        total_tokens = base_tokens + transition_tokens

        print(
            f"Transition token calculation: {num_images} {visual_type} clips = {total_batches} batches (batch_size={batch_size}, cost_per_batch={cost_per_batch})")
        print(
            f"Base tokens: {base_tokens}, Additional batches: {additional_batches}, Transition tokens: {transition_tokens}")
        print(f"Total tokens needed: {total_tokens}")

        return total_tokens
    else:
        print(
            f"Standard video processing tokens: {base_tokens} (no transitions or ≤{batch_size} {visual_type} clips)")
        return base_tokens


def get_next_video_variant(supabase, user_id, group_id):
    """Get the next variant number for a final video document.
    Queries existing final video records and returns max_variant + 1,
    or 1 if no existing videos are found."""
    try:
        result = supabase.table("story_documents").select("variant").eq(
            "user_id", user_id
        ).eq("group_id", group_id).eq("description", "Final Video").execute()
        if result.data and len(result.data) > 0:
            max_variant = max((row.get("variant") or 1) for row in result.data)
            return max_variant + 1
        return 1
    except Exception as e:
        print(
            f"Warning: Could not determine next variant, defaulting to 1: {e}")
        return 1


def parse_settings_json(settings_raw):
    """Helper function to parse settings JSON safely"""
    if isinstance(settings_raw, str):
        try:
            return json.loads(settings_raw)
        except json.JSONDecodeError:
            print(f"Failed to parse settings JSON: {settings_raw}")
            return {}
    else:
        return settings_raw if settings_raw else {}


def _supabase_storage_headers(supabase_key):
    """Build headers safe for both legacy JWT service_role keys and the new
    sb_secret_ API keys.

    Per Supabase docs (https://supabase.com/docs/guides/getting-started/api-keys):
    "You cannot send a publishable or secret key in the Authorization: Bearer ... header,
    except if the value exactly equals the apikey header." We therefore always pass the
    same value in both headers — this works for both key formats.
    """
    return {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }


def get_signed_storage_url(supabase_url, supabase_key, bucket, object_path, expires_in=3600):
    """Mint a signed URL for a private object in Supabase Storage.

    Works with both legacy JWT keys and new sb_secret_ keys. Using a signed URL
    sidesteps the silent-failure mode where direct authenticated GETs on
    /storage/v1/object/<bucket>/<path> return non-file bodies (e.g. small JSON
    errors) with a 2xx status under certain key/permission combinations.
    """
    api = f"{supabase_url}/storage/v1/object/sign/{bucket}/{object_path}"
    headers = _supabase_storage_headers(supabase_key)
    headers["Content-Type"] = "application/json"
    resp = requests.post(api, headers=headers, json={
                         "expiresIn": expires_in}, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(
            f"Failed to sign {bucket}/{object_path}: HTTP {resp.status_code} body={resp.text[:300]}"
        )
    data = resp.json()
    signed = data.get("signedURL") or data.get("signedUrl")
    if not signed:
        raise RuntimeError(
            f"No signedURL in response for {bucket}/{object_path}: {data}")
    # signedURL is a relative path like "/object/sign/<bucket>/<path>?token=..."
    if signed.startswith("/"):
        return f"{supabase_url}/storage/v1{signed}"
    return f"{supabase_url}/storage/v1/{signed}"


def download_file(url, local_path, headers, expect_media=True, min_bytes=1024):
    """Download a file with retry logic.

    When ``expect_media`` is True (the default), validates the response so that
    Supabase Storage error bodies (small JSON / HTML returned with a 2xx status
    under certain auth scenarios) are not silently written to disk and later
    handed to ffmpeg/ffprobe as garbage. Set ``expect_media=False`` for callers
    that legitimately fetch small JSON/text payloads.
    """
    max_retries = 5
    last_error = None
    for attempt in range(max_retries):
        try:
            response = requests.get(
                url, headers=headers, stream=True, timeout=300)
            response.raise_for_status()

            if expect_media:
                ctype = (response.headers.get("Content-Type") or "").lower()
                if any(bad in ctype for bad in ("application/json", "text/html", "text/plain")):
                    head = response.text[:300]
                    raise RuntimeError(
                        f"Refusing to save non-media response (Content-Type={ctype}, "
                        f"url={url[:120]}...): {head}")

            cl_header = response.headers.get("Content-Length")
            ce_header = response.headers.get("Content-Encoding")
            ct_header = response.headers.get("Content-Type")
            etag_header = response.headers.get("ETag")
            with open(local_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)

            if expect_media:
                actual = os.path.getsize(local_path)
                with open(local_path, "rb") as fh:
                    head_bytes = fh.read(32)
                print(
                    f"[download_file] url_tail={url[-80:]} CT={ct_header} "
                    f"CL_header={cl_header} CE={ce_header} ETag={etag_header} "
                    f"bytes_written={actual} first32_hex={head_bytes.hex()}"
                )
                # Detect Content-Length / actual size mismatch (truncated download)
                if cl_header is not None:
                    try:
                        expected = int(cl_header)
                        if expected != actual:
                            try:
                                os.remove(local_path)
                            except OSError:
                                pass
                            raise RuntimeError(
                                f"Content-Length mismatch: header={expected} actual={actual}"
                            )
                    except ValueError:
                        pass
                if actual < min_bytes:
                    try:
                        os.remove(local_path)
                    except OSError:
                        pass
                    raise RuntimeError(
                        f"Downloaded body too small ({actual} bytes < {min_bytes}); "
                        f"first bytes={head_bytes!r}")
                # Magic-byte validation for known audio/video extensions
                lower_path = local_path.lower()
                if lower_path.endswith(".mp3"):
                    is_id3 = head_bytes[:3] == b"ID3"
                    is_sync = (
                        len(head_bytes) >= 2
                        and head_bytes[0] == 0xFF
                        and (head_bytes[1] & 0xE0) == 0xE0
                    )
                    if not (is_id3 or is_sync):
                        try:
                            os.remove(local_path)
                        except OSError:
                            pass
                        raise RuntimeError(
                            f"Downloaded file is not a valid MP3 "
                            f"(first32_hex={head_bytes.hex()}, CT={ct_header}, "
                            f"CL={cl_header}, CE={ce_header})"
                        )
                elif lower_path.endswith(".wav"):
                    if head_bytes[:4] != b"RIFF" or head_bytes[8:12] != b"WAVE":
                        try:
                            os.remove(local_path)
                        except OSError:
                            pass
                        raise RuntimeError(
                            f"Downloaded file is not a valid WAV "
                            f"(first32_hex={head_bytes.hex()}, CT={ct_header})"
                        )
            return True
        except Exception as e:
            last_error = e
            print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(5)
    if last_error is not None:
        print(
            f"All {max_retries} download attempts failed for {url[:160]}: {last_error}")
    return False


def download_loop_video(video_loop_url, temp_dir):
    """Download the video loop file"""
    try:
        print(f"Downloading video loop from: {video_loop_url}")

        # Determine file extension from URL or default to .mp4
        if video_loop_url.lower().endswith('.mp4'):
            loop_video_path = os.path.join(temp_dir, "loop_video.mp4")
        else:
            loop_video_path = os.path.join(temp_dir, "loop_video.mp4")

        if download_file(video_loop_url, loop_video_path, {}):
            print(f"Successfully downloaded video loop")
            return loop_video_path
        else:
            print("Failed to download video loop")
            return None

    except Exception as e:
        print(f"Error downloading video loop: {str(e)}")
        return None


def get_video_duration(video_path):
    """Get video duration using ffprobe"""
    try:
        ffprobe_path = os.path.join(os.getcwd(), "ffprobe")
        cmd = [
            ffprobe_path, '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', video_path
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise ValueError(f"Failed to get duration: {result.stderr}")
        return float(result.stdout.strip())
    except Exception as e:
        print(f"Error getting video duration: {str(e)}")
        return 10.0  # Default fallback


def create_looped_video(video_path, target_duration, temp_dir, audio_delay=0.4):
    """Create looped video with specified duration using temp file copy approach"""
    try:
        print(
            f"Creating looped video with target duration: {target_duration} seconds")

        # Get original video duration
        original_duration = get_video_duration(video_path)
        print(f"Original video duration: {original_duration} seconds")

        if original_duration <= 0:
            print("Error: Invalid video duration")
            return None

        # Calculate how many loops we need (can be fractional)
        loops_needed = target_duration / original_duration
        print(f"Loops needed: {loops_needed}")

        # Calculate number of copies needed (ceiling to ensure enough copies)
        num_copies = int(loops_needed)
        fractional_copy = loops_needed % 1 > 0  # Check if there's a fractional part
        if fractional_copy:
            num_copies += 1

        print(f"Creating {num_copies} temporary copies for concatenation")

        # Create temporary copies
        copied_files = []
        base_name = os.path.splitext(os.path.basename(video_path))[0]
        ext = os.path.splitext(video_path)[1]

        try:
            for i in range(num_copies):
                copy_name = f"{base_name}_copy_{i+1}{ext}"
                copy_path = os.path.join(temp_dir, copy_name)
                shutil.copy(video_path, copy_path)
                copied_files.append(copy_path)
                print(f"Created copy {i+1}/{num_copies}: {copy_name}")

            # Create the file list for FFmpeg
            file_list_path = os.path.join(temp_dir, 'loop_file_list.txt')
            with open(file_list_path, 'w') as file_list:
                for file_path in copied_files:
                    # Use just the filename for the concat list
                    file_name = os.path.basename(file_path)
                    file_list.write(f"file '{file_name}'\n")

            print(f"Created concat file list with {len(copied_files)} entries")

            # Create looped video using concat with stream copy (no re-encoding)
            looped_video_path = os.path.join(temp_dir, "looped_video.mp4")

            # Run FFmpeg to concatenate and trim to exact duration using stream copy
            ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")
            cmd = [
                ffmpeg_path, '-f', 'concat', '-safe', '0', '-i', file_list_path,
                '-c', 'copy',  # Use stream copy instead of re-encoding
                '-t', str(target_duration),
                '-y', looped_video_path
            ]

            print(f"Running FFmpeg concat command with stream copy...")
            result = subprocess.run(
                cmd, check=True, capture_output=True, cwd=temp_dir)
            print(f"Successfully created looped video: {looped_video_path}")

            # Verify the output duration
            output_duration = get_video_duration(looped_video_path)
            print(
                f"Output video duration: {output_duration:.2f}s (target was {target_duration:.2f}s)")

            return looped_video_path

        finally:
            # Clean up temporary files
            print("Cleaning up temporary files...")
            for file_path in copied_files:
                try:
                    if os.path.exists(file_path):
                        os.remove(file_path)
                except OSError as e:
                    print(
                        f"Warning: Could not remove temp file {file_path}: {e}")

            if 'file_list_path' in locals():
                try:
                    if os.path.exists(file_list_path):
                        os.remove(file_list_path)
                except OSError as e:
                    print(f"Warning: Could not remove file list: {e}")

    except Exception as e:
        print(f"Error creating looped video: {str(e)}")
        return None


def combine_loop_video_with_audio(loop_video_path, audio_path, bg_music_path, output_path, bg_music_volume=0.25, audio_delay=0.4):
    """Combine looped video with audio, starting audio 0.4 seconds after video"""
    try:
        ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

        if bg_music_path:
            print(
                "Combining looped video with main audio and background music (0.4s delay)")

            # Get video duration to match background music length
            video_duration = get_video_duration(loop_video_path)
            audio_duration = get_audio_duration(audio_path)
            print(f"Video duration: {video_duration} seconds")
            print(f"Audio duration: {audio_duration} seconds")

            # Create looped background music that matches video duration
            looped_bg_music_path = os.path.join(
                os.path.dirname(output_path), "looped_bg_music.wav")

            # First, convert background music to WAV and loop it
            subprocess.run([
                ffmpeg_path, "-stream_loop", "-1", "-i", bg_music_path,
                "-t", str(video_duration),
                "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "2",
                "-y", looped_bg_music_path
            ], check=True, capture_output=True)
            print("Background music converted to WAV and looped to match video duration")

            # Create padded main audio to match video duration if needed
            padded_main_audio_path = os.path.join(
                os.path.dirname(output_path), "padded_main_audio.wav")

            if video_duration > audio_duration:
                silence_duration = video_duration - audio_duration
                print(
                    f"Padding main audio with {silence_duration:.2f}s of silence")

                # Create padded main audio first
                subprocess.run([
                    ffmpeg_path, "-i", audio_path,
                    "-f", "lavfi", "-i", f"anullsrc=channel_layout=mono:sample_rate=24000",
                    "-filter_complex", f"[0:a]adelay=400|400[delayed];[1:a]atrim=duration={silence_duration}[silence];[delayed][silence]concat=n=2:v=0:a=1[out]",
                    "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1",
                    "-y", padded_main_audio_path
                ], check=True, capture_output=True)
            else:
                # Just add delay to main audio
                subprocess.run([
                    ffmpeg_path, "-i", audio_path,
                    "-filter_complex", "[0:a]adelay=400|400[delayed]",
                    "-map", "[delayed]", "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1",
                    "-y", padded_main_audio_path
                ], check=True, capture_output=True)

            # Then mix with background music
            subprocess.run([
                ffmpeg_path, "-i", loop_video_path,
                "-i", padded_main_audio_path, "-i", looped_bg_music_path,
                "-filter_complex",
                f"[1:a]volume=1.0[main_audio];[2:a]volume={bg_music_volume}[bg_audio];[main_audio][bg_audio]amix=inputs=2:duration=longest:dropout_transition=3:normalize=0[mixed_audio]",
                "-map", "0:v:0", "-map", "[mixed_audio]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                "-y", output_path
            ], check=True, capture_output=True)
            print("Video created with main audio (0.4s delay) and background music")
        else:
            print("Combining looped video with main audio only (0.4s delay)")

            # Get actual durations first
            video_duration = get_video_duration(loop_video_path)
            audio_duration = get_audio_duration(audio_path)

            print(f"Video duration: {video_duration:.2f}s")
            print(f"Audio duration: {audio_duration:.2f}s")

            if video_duration > audio_duration:
                # Create padded audio to match video duration
                silence_duration = video_duration - audio_duration
                print(f"Padding audio with {silence_duration:.2f}s of silence")

                padded_audio_path = os.path.join(
                    os.path.dirname(output_path), "padded_audio.wav")

                # Create silence and concatenate with delayed original audio
                subprocess.run([
                    ffmpeg_path, "-i", audio_path,
                    "-f", "lavfi", "-i", f"anullsrc=channel_layout=mono:sample_rate=24000",
                    "-filter_complex", f"[0:a]adelay=400|400[delayed];[1:a]atrim=duration={silence_duration}[silence];[delayed][silence]concat=n=2:v=0:a=1[out]",
                    "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "24000", "-ac", "1",
                    "-y", padded_audio_path
                ], check=True, capture_output=True)

                # Combine video with padded audio
                subprocess.run([
                    ffmpeg_path, "-i", loop_video_path, "-i", padded_audio_path,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                    "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                    "-y", output_path
                ], check=True, capture_output=True)
            else:
                # Audio is longer or equal, just add delay
                subprocess.run([
                    ffmpeg_path, "-i", loop_video_path, "-i", audio_path,
                    "-filter_complex", "[1:a]adelay=400|400[delayed_audio]",
                    "-map", "0:v:0", "-map", "[delayed_audio]",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                    "-avoid_negative_ts", "make_zero", "-fflags", "+genpts",
                    "-y", output_path
                ], check=True, capture_output=True)

            print("Video created with main audio (0.4s delay + controlled padding)")

        return True

    except Exception as e:
        print(f"Error combining loop video with audio: {str(e)}")
        return False


def detect_audio_file_type(supabase_url, supabase_key, audio_path):
    """Detect whether audio files are .mp3 or .wav by checking what exists.

    Case-insensitive matching (uploads can use .MP3 / .WAV from some clients).
    Defaults to .mp3 since the overwhelming majority of uploads are MP3.
    """
    try:
        headers = _supabase_storage_headers(supabase_key)
        list_url = f"{supabase_url}/storage/v1/object/list/stories"

        list_response = requests.post(
            list_url,
            json={"prefix": audio_path, "limit": 1000},
            headers=headers
        )

        if list_response.status_code == 200:
            files = list_response.json()

            # Check for both extensions and use whichever is found (case-insensitive)
            for ext in ['.mp3', '.wav']:
                for f in files:
                    name = (f.get("name") or "")
                    if name.lower().endswith(ext):
                        filename = os.path.basename(name)
                        match = re.match(r'group_(\d+)' +
                                         re.escape(ext), filename, re.IGNORECASE)
                        if match:
                            print(
                                f"Detected audio files with extension: {ext}")
                            return ext

            # If the prefix itself resolves to a single file (i.e. audio_path is
            # the full object path for a single uploaded MP3/WAV), trust its extension.
            for f in files:
                name = (f.get("name") or "").lower()
                if name.endswith('.mp3'):
                    print("Detected single audio file with extension: .mp3")
                    return '.mp3'
                if name.endswith('.wav'):
                    print("Detected single audio file with extension: .wav")
                    return '.wav'

            # Check for merged single files
            for ext in ['.mp3', '.wav']:
                possible_paths = [
                    f"{audio_path}/merged{ext}",
                    f"{audio_path}merged{ext}",
                ]
                for path in possible_paths:
                    try:
                        signed = get_signed_storage_url(
                            supabase_url, supabase_key, "stories", path, expires_in=300)
                        response = requests.head(signed, timeout=15)
                        if response.status_code == 200:
                            print(
                                f"Detected single audio file with extension: {ext}")
                            return ext
                    except Exception:
                        continue

        print("No audio files detected, defaulting to .mp3")
        return '.mp3'  # Default fallback (MP3 is the dominant upload format)

    except Exception as e:
        print(f"Error detecting audio file type: {str(e)}, defaulting to .mp3")
        return '.mp3'


def download_and_merge_audio_files(supabase_url, supabase_key, audio_path, temp_dir):
    """Download and merge audio files from folder or single file.

    All Storage downloads go through short-lived signed URLs (minted with the
    secret key). This works for both legacy JWT service_role keys and the new
    sb_secret_ API keys, and avoids the silent-failure mode where direct
    authenticated GETs to /storage/v1/object/<bucket>/<path> return a small
    non-file body with a 2xx status (which would otherwise be written to disk
    and later fail ffprobe with confusing codec errors).
    """
    headers = _supabase_storage_headers(supabase_key)

    try:
        print(f"Attempting to download audio from path: {audio_path}")

        # Detect the audio file extension dynamically
        detected_extension = detect_audio_file_type(
            supabase_url, supabase_key, audio_path)
        print(f"Looking for audio files with extension: {detected_extension}")

        # First, try to list files in the audio path (assuming it's a folder)
        list_url = f"{supabase_url}/storage/v1/object/list/stories"
        list_response = requests.post(
            list_url,
            json={"prefix": audio_path, "limit": 1000},
            headers=headers
        )

        if list_response.status_code == 200:
            files = list_response.json()
            print(f"Found {len(files)} files in audio path")

            # Filter for audio files with detected extension (case-insensitive)
            audio_files = []
            for f in files:
                name = f.get("name") or ""
                if name.lower().endswith(detected_extension):
                    # Extract group number from filename (group_1.wav, group_2.wav, etc.)
                    filename = os.path.basename(name)
                    match = re.match(r'group_(\d+)' +
                                     re.escape(detected_extension), filename, re.IGNORECASE)
                    if match:
                        group_num = int(match.group(1))
                        # Construct the full path by combining audio_path with the filename
                        # The API returns relative paths, so we need to construct the full path
                        if name == filename:  # If API returned just filename
                            full_file_path = f"{audio_path}/{filename}"
                        else:  # If API returned full path
                            full_file_path = name

                        audio_files.append((group_num, full_file_path))
                        print(
                            f"Found audio file: {filename} at constructed path: {full_file_path}")

            if audio_files:
                # Sort by group number
                audio_files.sort(key=lambda x: x[0])
                print(f"Found {len(audio_files)} audio files to merge")

                # Download all audio files
                local_audio_files = []
                for group_num, file_path in audio_files:
                    local_filename = f"group_{group_num}{detected_extension}"
                    local_path = os.path.join(temp_dir, local_filename)

                    try:
                        signed = get_signed_storage_url(
                            supabase_url, supabase_key, "stories", file_path)
                    except Exception as sign_err:
                        print(f"Failed to sign {file_path}: {sign_err}")
                        return None, detected_extension

                    print(f"Downloading {local_filename} via signed URL")

                    # Signed URL is self-authenticating; pass no auth headers.
                    if download_file(signed, local_path, {}):
                        local_audio_files.append(local_path)
                        print(f"Downloaded {local_filename}")
                    else:
                        print(f"Failed to download {local_filename}")
                        return None, detected_extension

                if not local_audio_files:
                    print("No audio files downloaded successfully")
                    return None, detected_extension

                # Merge audio files using ffmpeg
                merged_audio_path = os.path.join(
                    temp_dir, f"merged_audio{detected_extension}")

                if len(local_audio_files) == 1:
                    # Only one file, just copy it
                    import shutil
                    shutil.copy2(local_audio_files[0], merged_audio_path)
                    print("Single audio file copied as merged audio")
                else:
                    # Create file list for ffmpeg concat
                    file_list_path = os.path.join(temp_dir, "audio_list.txt")
                    with open(file_list_path, "w") as f:
                        for audio_file in local_audio_files:
                            f.write(f"file '{os.path.basename(audio_file)}'\n")

                    ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

                    try:
                        subprocess.run([
                            ffmpeg_path, "-f", "concat", "-safe", "0", "-i", file_list_path,
                            "-c", "copy", "-avoid_negative_ts", "make_zero",
                            merged_audio_path
                        ], check=True, capture_output=True, cwd=temp_dir)
                        print("Audio files merged successfully")
                    except subprocess.CalledProcessError as e:
                        print(f"FFmpeg audio merge error: {e.stderr.decode()}")
                        return None, detected_extension

                return merged_audio_path, detected_extension

        # If listing failed or no grouped files found, try as single file
        print("No grouped audio files found, trying to download as single audio file")
        single_audio_path = os.path.join(
            temp_dir, f"single_audio{detected_extension}")

        # Try different possible single file paths
        possible_paths = [
            audio_path,  # Direct path (if it's a file)
            # merged.wav/merged.mp3 in folder
            f"{audio_path}/merged{detected_extension}",
            # merged.wav/merged.mp3 appended to folder path
            f"{audio_path}merged{detected_extension}",
        ]

        for path in possible_paths:
            try:
                signed = get_signed_storage_url(
                    supabase_url, supabase_key, "stories", path)
            except Exception as sign_err:
                print(f"Could not sign {path}: {sign_err}")
                continue
            print(f"Trying to download single audio file from path: {path}")
            if download_file(signed, single_audio_path, {}):
                print(f"Downloaded single audio file from {path}")
                return single_audio_path, detected_extension

        print("Failed to download any audio files")
        return None, detected_extension

    except Exception as e:
        print(f"Error downloading audio files: {str(e)}")
        return None, '.mp3'


def download_background_music(bg_music_url, temp_dir):
    """Download background music file"""
    try:
        print(f"Downloading background music from: {bg_music_url}")

        # Determine file extension from URL or default to .mp3
        if bg_music_url.lower().endswith('.mp4'):
            bg_music_path = os.path.join(temp_dir, "bg_music.mp4")
        elif bg_music_url.lower().endswith('.wav'):
            bg_music_path = os.path.join(temp_dir, "bg_music.wav")
        else:
            bg_music_path = os.path.join(temp_dir, "bg_music.mp3")

        if download_file(bg_music_url, bg_music_path, {}):
            print(f"Successfully downloaded background music")
            return bg_music_path
        else:
            print("Failed to download background music")
            return None

    except Exception as e:
        print(f"Error downloading background music: {str(e)}")
        return None


def verify_file_exists_in_supabase(supabase_url, supabase_key, bucket, file_path):
    """Verify if a file exists in Supabase storage"""
    try:
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # Try to get file info
        info_url = f"{supabase_url}/storage/v1/object/info/{bucket}/{file_path}"
        response = requests.get(info_url, headers=headers)

        if response.status_code == 200:
            file_info = response.json()
            print(
                f"File verified in storage: {file_path}, size: {file_info.get('size', 'unknown')} bytes")
            return True, file_info.get('size', 0)
        else:
            print(
                f"File not found in storage: {file_path} (status: {response.status_code})")
            return False, 0

    except Exception as e:
        print(f"Error verifying file existence: {str(e)}")
        return False, 0


def upload_file_chunked_resumable(supabase_url, supabase_key, file_path, upload_path, bucket='videos', content_type='video/mp4', chunk_size=6*1024*1024, max_retries=3):
    """Upload large file using Supabase's TUS resumable upload with retry logic"""
    for attempt in range(max_retries):
        try:
            from tusclient import client

            file_size = os.path.getsize(file_path)
            print(
                f"TUS upload attempt {attempt + 1}/{max_retries} for {upload_path}, file size: {file_size} bytes")

            # Use direct storage hostname for better performance
            tus_url = f"{supabase_url.replace('.supabase.co', '.storage.supabase.co')}/storage/v1/upload/resumable"

            tus_client = client.TusClient(
                tus_url,
                headers={
                    "Authorization": f"Bearer {supabase_key}",
                    "apikey": supabase_key,
                    "x-upsert": "true"
                }
            )

            with open(file_path, 'rb') as file_stream:
                uploader = tus_client.uploader(
                    file_stream=file_stream,
                    chunk_size=chunk_size,
                    metadata={
                        "bucketName": bucket,
                        "objectName": upload_path,
                        "contentType": content_type
                    }
                )
                uploader.upload()

            print("TUS upload completed successfully")
            return True, file_size

        except Exception as e:
            print(f"TUS upload attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                wait_time = (2 ** attempt) * 30  # 30s, 60s, 120s
                print(f"Waiting {wait_time}s before retry...")
                time.sleep(wait_time)
            else:
                print("All TUS upload attempts failed")
                return False, 0

    return False, 0


def upload_file_to_supabase_with_verification(supabase, file_path, upload_path, bucket='videos', content_type='video/mp4'):
    """Upload file to Supabase storage with verification and retry logic - now supports chunked upload for large files"""
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SECRET_KEY")

    file_size = os.path.getsize(file_path)

    # Use chunked upload for files larger than 80MB to stay well under Cloudflare's 100MB limit
    if file_size > 80 * 1024 * 1024:
        print(f"Large file detected ({file_size} bytes), using chunked upload")
        return upload_file_chunked_resumable(supabase_url, supabase_key, file_path, upload_path, bucket, content_type)

    # For smaller files, use the original method
    max_retries = 10
    initial_wait = 120  # 2 minutes initial wait

    for attempt in range(max_retries):
        try:
            print(
                f"Upload attempt {attempt + 1}/{max_retries} for {upload_path}")

            upload_url = f"{supabase_url}/storage/v1/object/{bucket}/{upload_path}"
            headers = {
                "Authorization": f"Bearer {supabase_key}",
                "apikey": supabase_key,
                "Content-Type": content_type,
                # Overwrite if file already exists (prevents 409 on retries)
                "x-upsert": "true"
            }

            with open(file_path, "rb") as f:
                response = requests.post(
                    upload_url,
                    data=f,
                    headers=headers
                )

            # Check if upload was successful OR if we got a 502/503 (which might still work)
            if response.status_code == 200:
                print(f"Upload successful for {upload_path} (HTTP 200)")
                return True, os.path.getsize(file_path)
            elif response.status_code in [502, 503, 504]:
                print(
                    f"Upload got {response.status_code} error, but file might still be uploaded. Checking...")

                # Wait before verification
                wait_time = initial_wait if attempt == 0 else 30
                print(f"Waiting {wait_time} seconds before verification...")
                time.sleep(wait_time)

                # Verify if file actually exists
                file_exists, file_size = verify_file_exists_in_supabase(
                    supabase_url, supabase_key, bucket, upload_path)

                if file_exists:
                    print(
                        f"Upload actually successful despite {response.status_code} error!")
                    return True, file_size
                else:
                    print(
                        f"File not found after {response.status_code} error, will retry...")
                    if attempt < max_retries - 1:
                        time.sleep(10)  # Short wait before retry
                    continue
            else:
                print(
                    f"Upload failed with status {response.status_code}: {response.text}")
                if attempt < max_retries - 1:
                    time.sleep(10)  # Short wait before retry
                continue

        except requests.exceptions.Timeout:
            print(f"Upload timeout on attempt {attempt + 1}")
            # Even on timeout, check if file was uploaded
            print("Checking if file was uploaded despite timeout...")
            time.sleep(30)
            file_exists, file_size = verify_file_exists_in_supabase(
                supabase_url, supabase_key, bucket, upload_path)
            if file_exists:
                print("Upload successful despite timeout!")
                return True, file_size
            elif attempt < max_retries - 1:
                print("File not found, retrying upload...")
                time.sleep(10)
            continue

        except Exception as e:
            print(f"Upload error on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(10)
            continue

    # Final verification attempt
    print("All upload attempts failed, doing final verification...")
    file_exists, file_size = verify_file_exists_in_supabase(
        supabase_url, supabase_key, bucket, upload_path)
    if file_exists:
        print("File found in final verification - upload was actually successful!")
        return True, file_size

    print(f"Upload failed after {max_retries} attempts")
    return False, 0


def upload_file_to_supabase(supabase, file_path, upload_path, bucket='videos', content_type='video/mp4'):
    """Upload file to Supabase storage using requests directly - wrapper for backward compatibility"""
    success, file_size = upload_file_to_supabase_with_verification(
        supabase, file_path, upload_path, bucket, content_type)
    return success


def delete_folder_from_supabase(supabase_url, supabase_key, bucket, folder_path):
    """Delete a folder and all its contents from Supabase storage"""
    try:
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # List all files in the folder
        list_url = f"{supabase_url}/storage/v1/object/list/{bucket}"
        list_response = requests.post(
            list_url,
            json={"prefix": folder_path, "limit": 1000},
            headers=headers
        )
        list_response.raise_for_status()

        files = list_response.json()
        if not files:
            print(f"No files found in folder {folder_path}")
            return True

        # Collect actual file paths with full paths
        file_paths = []
        for f in files:
            if f.get("name"):
                # Construct full path if the API returned just filename
                if "/" not in f["name"] or not f["name"].startswith(folder_path):
                    full_path = f"{folder_path}/{f['name']}"
                else:
                    full_path = f["name"]
                file_paths.append(full_path)
                print(f"Found file to delete: {full_path}")

        if not file_paths:
            print(f"No valid file paths found in folder {folder_path}")
            return True

        print(
            f"Found {len(file_paths)} files to delete in folder {folder_path}")

        # Delete files individually using full paths
        delete_url = f"{supabase_url}/storage/v1/object/{bucket}"
        successful_deletions = 0

        for file_path in file_paths:
            try:
                delete_response = requests.delete(
                    delete_url,
                    json={"prefixes": [file_path]},
                    headers=headers
                )

                if delete_response.status_code == 200:
                    print(f"Successfully deleted: {file_path}")
                    successful_deletions += 1
                else:
                    print(
                        f"Failed to delete {file_path}: {delete_response.status_code} - {delete_response.text}")

            except Exception as e:
                print(f"Error deleting file {file_path}: {str(e)}")

        print(
            f"Successfully deleted {successful_deletions} out of {len(file_paths)} files from folder {folder_path}")

        # Verify deletion with a small delay
        time.sleep(2)
        verify_response = requests.post(
            list_url,
            json={"prefix": folder_path, "limit": 10},
            headers=headers
        )
        verify_response.raise_for_status()
        remaining_files = verify_response.json()

        if remaining_files and len(remaining_files) > 0:
            print(
                f"Warning: {len(remaining_files)} files still remain in folder {folder_path}")
            # Log what files are still there
            for remaining_file in remaining_files:
                print(
                    f"Remaining file: {remaining_file.get('name', 'unknown')}")
            return successful_deletions == len(file_paths)
        else:
            print(f"Successfully deleted all contents of folder {folder_path}")
            return True

    except Exception as e:
        print(f"Error deleting folder {folder_path}: {str(e)}")
        return False


def delete_file_from_supabase(supabase_url, supabase_key, bucket, file_path):
    """Delete a specific file from Supabase storage"""
    try:
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # Use the correct delete endpoint for single files
        delete_url = f"{supabase_url}/storage/v1/object/{bucket}"
        response = requests.delete(
            delete_url,
            json={"prefixes": [file_path]},
            headers=headers
        )

        if response.status_code == 200:
            print(f"Successfully deleted file {file_path}")
            return True
        else:
            print(
                f"Failed to delete file {file_path}: {response.status_code} - {response.text}")
            return False

    except Exception as e:
        print(f"Error deleting file {file_path}: {str(e)}")
        return False


def delete_task_rows(supabase, user_id, group_id):
    """Delete intermediate task rows after video creation is complete"""
    try:
        supabase.table("story_tasks").delete().eq(
            "user_id", user_id).eq("group_id", group_id).execute()
        supabase.table("image_prompt_tasks").delete().eq(
            "user_id", user_id).eq("group_id", group_id).execute()
        supabase.table("image_prompt_context").delete().eq(
            "group_id", group_id).execute()
        supabase.table("audio_tasks").delete().eq(
            "user_id", user_id).eq("group_id", group_id).execute()
        supabase.table("image_tasks").delete().eq(
            "user_id", user_id).eq("group_id", group_id).execute()
        print(f"Successfully deleted task rows for group {group_id}")
    except Exception as e:
        print(
            f"Warning: Error deleting task rows for group {group_id}: {str(e)}")


def cleanup_storage_after_completion(supabase_url, supabase_key, user_id, group_id, audio_path):
    """Clean up individual videos folder and merged audio file after final video is completed"""
    try:
        print("Starting storage cleanup...")

        # Delete individual_videos folder and all its contents
        individual_videos_folder = f"videos/{user_id}/{group_id}/individual_videos"
        print(f"Attempting to delete folder: {individual_videos_folder}")
        folder_deleted = delete_folder_from_supabase(
            supabase_url, supabase_key, "videos", individual_videos_folder
        )

        if folder_deleted:
            print("Individual videos folder deleted successfully")
        else:
            print("Warning: Individual videos folder deletion may have failed")

        # Delete transition batches folder
        transition_folder = f"videos/{user_id}/{group_id}/transition_batches"
        print(f"Attempting to delete folder: {transition_folder}")
        transition_deleted = delete_folder_from_supabase(
            supabase_url, supabase_key, "videos", transition_folder
        )

        if transition_deleted:
            print("Transition batches folder deleted successfully")
        else:
            print("Warning: Transition batches folder deletion may have failed")

        # Delete merged audio file from videos bucket (if it was copied there)
        # Note: We're keeping the original audio in the stories bucket, only cleaning up copies in videos bucket
        potential_audio_files = [
            f"videos/{user_id}/{group_id}/merged.wav",
            f"videos/{user_id}/{group_id}/merged.mp3",
            f"videos/{user_id}/{group_id}/audio.wav",
            f"videos/{user_id}/{group_id}/audio.mp3"
        ]

        for audio_file_path in potential_audio_files:
            try:
                result = delete_file_from_supabase(
                    supabase_url, supabase_key, "videos", audio_file_path)
                if result:
                    print(
                        f"Successfully deleted audio file: {audio_file_path}")
            except Exception as e:
                print(
                    f"Audio file {audio_file_path} deletion attempt (this is normal if file doesn't exist): {str(e)}")

        cleanup_success = folder_deleted and transition_deleted

        if cleanup_success:
            print("Storage cleanup completed successfully")
        else:
            print("Storage cleanup completed with some warnings")

        return cleanup_success

    except Exception as e:
        print(f"Error during storage cleanup: {str(e)}")
        return False


def remux_and_get_duration_ffmpeg(file_path):
    """Remux MP3 file to fix corrupted structure, then get accurate duration"""
    try:
        ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")
        ffprobe_path = os.path.join(os.getcwd(), "ffprobe")

        # Create remuxed file path
        remuxed_path = file_path.rsplit('.', 1)[0] + '_remuxed.mp3'

        print(f"Remuxing file to fix structure: {file_path}")

        # Remux: copy audio stream without re-encoding, strip bad metadata
        remux_cmd = [
            ffmpeg_path,
            "-i", file_path,
            "-c", "copy",  # Copy stream without re-encoding
            "-map_metadata", "-1",  # Strip all metadata
            "-y",  # Overwrite output
            remuxed_path
        ]

        remux_result = subprocess.run(
            remux_cmd, capture_output=True, text=True)

        if remux_result.returncode != 0:
            print(f"Remux warning: {remux_result.stderr}")
            target_file = file_path
        else:
            print(f"✅ Remuxed file created successfully")
            target_file = remuxed_path

        # Get duration from remuxed file
        probe_cmd = [
            ffprobe_path,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            target_file
        ]

        probe_result = subprocess.run(
            probe_cmd, capture_output=True, text=True)

        # Clean up remuxed file
        if os.path.exists(remuxed_path):
            try:
                os.remove(remuxed_path)
            except:
                pass

        if probe_result.returncode == 0 and probe_result.stdout.strip():
            duration = float(probe_result.stdout.strip())
            print(f"Duration after remux: {duration:.2f}s")
            return duration

        return 60.0
    except Exception as e:
        print(f"Error in remux_and_get_duration: {e}")
        return 60.0


def get_audio_duration(audio_path):
    """Get audio duration using ffprobe - with remux for merged MP3s"""
    try:
        # Detect merged MP3 files that need remuxing
        file_name = os.path.basename(audio_path)
        is_merged_mp3 = file_name.lower() == 'merged.mp3' or 'merged' in file_name.lower()

        if is_merged_mp3 and file_name.lower().endswith('.mp3'):
            print(f"Detected merged MP3 file, using remux method")
            return remux_and_get_duration_ffmpeg(audio_path)

        # For non-merged files, use regular ffprobe
        # Force input format so ffprobe never misidentifies an MP3/WAV
        # as a VVC bitstream (johnvansickle ffmpeg 7.x has VVC detection
        # that incorrectly scores some ID3-tagged MP3 headers as VVC).
        ffmpeg_path = os.path.join(os.getcwd(), "ffprobe")
        lower_path = audio_path.lower()
        if lower_path.endswith('.mp3'):
            forced_fmt = ['-f', 'mp3']
        elif lower_path.endswith('.wav'):
            forced_fmt = ['-f', 'wav']
        else:
            forced_fmt = []
        cmd = [ffmpeg_path] + forced_fmt + [
            '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', audio_path
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise ValueError(f"Failed to get duration: {result.stderr}")
        return float(result.stdout.strip())
    except Exception as e:
        print(f"Error getting audio duration: {str(e)}")
        return 60.0  # Default fallback


def natural_sort_key(s):
    """Key for natural sorting of filenames (e.g., video_1.mp4 before video_10.mp4)."""
    import re
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]


# ════════════════════════════════════════════════════════════════
# TTV/ITV SPEECH-AWARE CLIP ASSEMBLY HELPERS
# ════════════════════════════════════════════════════════════════

def build_atempo_chain(sf):
    """Build atempo filter chain for speed factors outside [0.5, 2.0]."""
    if sf < 0.5:
        return f'atempo={sf * 2:.6f},atempo=0.5'
    elif sf > 2.0:
        return f'atempo=2.0,atempo={sf / 2.0:.6f}'
    else:
        return f'atempo={sf:.6f}'


def speed_adjust_ttv_clips(local_video_files, clip_assembly_data, temp_dir, ffmpeg_path):
    """Speed-adjust TTV/ITV clips and extract speech clip audio.

    Returns:
        speed_adjusted_files: muted clips at target speed
        clip_audio_files: list of (clip_idx, audio_path, actual_dur) for speech clips
        actual_durations: seconds per clip after speed adjustment
    """
    speed_factors = clip_assembly_data.get('speed_factors', [])
    has_speech = clip_assembly_data.get('has_speech', [])

    speed_adjusted_files = []
    clip_audio_files = []
    actual_durations = []

    for idx, (local_path, sf) in enumerate(zip(local_video_files, speed_factors)):
        natural_dur = get_video_duration(local_path)
        actual_dur = natural_dur / sf if sf > 0 else natural_dur
        actual_durations.append(actual_dur)

        adjusted_path = os.path.join(temp_dir, f"adjusted_{idx:03d}.mp4")

        try:
            if abs(sf - 1.0) < 0.01:
                # No speed change — strip audio only
                subprocess.run([
                    ffmpeg_path, '-y', '-i', local_path,
                    '-an', '-c:v', 'copy', adjusted_path
                ], check=True, capture_output=True)
            else:
                speed_filter = f'setpts=PTS/{sf:.6f}'
                subprocess.run([
                    ffmpeg_path, '-y', '-i', local_path,
                    '-vf', speed_filter,
                    '-t', f'{actual_dur:.6f}',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                    '-pix_fmt', 'yuv420p',
                    '-an', adjusted_path
                ], check=True, capture_output=True)

            speed_adjusted_files.append(adjusted_path)
            tag = "🗣️" if (idx < len(has_speech) and has_speech[idx]) else "  "
            print(f"  {tag} Clip {idx+1}: speed ×{sf:.3f} "
                  f"({natural_dur:.2f}s → {actual_dur:.2f}s)")
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            print(f"  Clip {idx+1}: speed-adjust failed ({e}), using original")
            speed_adjusted_files.append(local_path)
            actual_durations[-1] = natural_dur

        # Extract speed-adjusted audio from speech clips
        if idx < len(has_speech) and has_speech[idx]:
            clip_audio_path = os.path.join(
                temp_dir, f"clip_audio_{idx:03d}.aac")
            atempo_chain = build_atempo_chain(sf)
            try:
                subprocess.run([
                    ffmpeg_path, '-y', '-i', local_path,
                    '-af', atempo_chain,
                    '-t', f'{actual_dur:.6f}',
                    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                    '-vn', clip_audio_path
                ], check=True, capture_output=True)
                clip_audio_files.append((idx, clip_audio_path, actual_dur))
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                # Clip may not have an audio stream — that's fine
                print(f"    Could not extract audio from speech clip {idx+1}")

    return speed_adjusted_files, clip_audio_files, actual_durations


def assemble_speech_audio(
    concatenated_video_path, audio_local_path, clip_audio_files,
    clip_assembly_data, actual_durations, use_transitions, transition_duration,
    bg_music_local_path, bg_music_volume, final_video_path,
    ffmpeg_path, temp_dir
):
    """Build gapped narration + clip audio mix for TTV/ITV with speech.

    1. Combine speech clips' audio into one track at correct timeline offsets
    2. Build gapped narration (silence during speech, narration otherwise)
    3. Mix everything into the final video

    Returns True on success.
    """
    has_speech = clip_assembly_data.get('has_speech', [])
    original_stt_durations = clip_assembly_data.get(
        'original_stt_durations',
        clip_assembly_data.get('target_durations', [])
    )

    total_video_dur = get_video_duration(concatenated_video_path)
    print(f"\n=== Speech audio assembly (video: {total_video_dur:.1f}s) ===")

    # ── 1. Segment start times (accounting for transitions) ─────
    segment_starts = [0.0]
    for i, dur in enumerate(actual_durations[:-1]):
        if use_transitions and transition_duration > 0:
            segment_starts.append(
                segment_starts[-1] + dur - transition_duration)
        else:
            segment_starts.append(segment_starts[-1] + dur)

    # ── 2. Combined clip audio track (acrossfade, matches SSAIVidGen.py) ────
    clip_audio_combined = os.path.join(temp_dir, "clip_audio_combined.aac")
    has_clip_audio = False

    if clip_audio_files:
        # Sort by clip index to ensure sequential order
        clip_audio_sorted = sorted(clip_audio_files, key=lambda x: x[0])
        total_clips = len(actual_durations)
        all_sequential = (len(clip_audio_sorted) == total_clips and
                          all(clip_audio_sorted[i][0] == i
                              for i in range(total_clips)))

        if all_sequential and use_transitions and len(clip_audio_sorted) > 1:
            # ── Acrossfade chain mirroring video xfade offsets (SSAIVidGen.py) ──
            ca_input_args = []
            for _, ap, _ in clip_audio_sorted:
                ca_input_args.extend(['-i', ap])
            a_filter_parts = []
            a_prev = '[0:a]'
            for ai in range(1, len(clip_audio_sorted)):
                a_label = f'[atmp{ai}]'
                a_filter_parts.append(
                    f'{a_prev}[{ai}:a]acrossfade=d={transition_duration}:'
                    f'c1=tri:c2=tri{a_label};')
                a_prev = a_label
            a_filter_str = ''.join(a_filter_parts).rstrip(';')

            try:
                subprocess.run([
                    ffmpeg_path, '-y'] + ca_input_args + [
                    '-filter_complex', a_filter_str,
                    '-map', a_prev,
                    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                    clip_audio_combined
                ], check=True, capture_output=True)
                has_clip_audio = True
                print(
                    f"  Clip audio crossfaded: {len(clip_audio_sorted)} tracks")
            except subprocess.CalledProcessError as e:
                print(f"  Warning: acrossfade failed, trying simple concat: "
                      f"{e.stderr.decode()[:200]}")
                # Fallback: simple concat (matches SSAIVidGen.py fallback)
                concat_list_path = os.path.join(
                    temp_dir, "audio_concat_list.txt")
                with open(concat_list_path, 'w') as clf:
                    for _, ap, _ in clip_audio_sorted:
                        clf.write(f"file '{ap}'\n")
                try:
                    subprocess.run([
                        ffmpeg_path, '-y', '-f', 'concat', '-safe', '0',
                        '-i', concat_list_path,
                        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                        clip_audio_combined
                    ], check=True, capture_output=True)
                    has_clip_audio = True
                    print(
                        f"  Clip audio concat fallback: {len(clip_audio_sorted)} tracks")
                except subprocess.CalledProcessError:
                    print("  Clip audio concat fallback also failed")

        elif all_sequential and len(clip_audio_sorted) > 1:
            # No transitions — simple concat (matches SSAIVidGen.py)
            concat_list_path = os.path.join(temp_dir, "audio_concat_list.txt")
            with open(concat_list_path, 'w') as clf:
                for _, ap, _ in clip_audio_sorted:
                    clf.write(f"file '{ap}'\n")
            try:
                subprocess.run([
                    ffmpeg_path, '-y', '-f', 'concat', '-safe', '0',
                    '-i', concat_list_path,
                    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                    clip_audio_combined
                ], check=True, capture_output=True)
                has_clip_audio = True
                print(
                    f"  Clip audio combined: {len(clip_audio_sorted)} tracks")
            except subprocess.CalledProcessError as e:
                print(f"  Warning: clip audio concat failed: "
                      f"{e.stderr.decode()[:200]}")

        else:
            # Partial clips or single clip — adelay+amix fallback
            ca_input_args = []
            ca_filter_parts = []
            ca_labels = []
            for fi, (clip_idx, audio_path, dur) in enumerate(clip_audio_files):
                ca_input_args.extend(['-i', audio_path])
                delay_ms = int(segment_starts[clip_idx] * 1000)
                label = f'[ca{fi}]'
                ca_filter_parts.append(
                    f'[{fi}:a]adelay={delay_ms}|{delay_ms}{label}')
                ca_labels.append(label)
            if len(clip_audio_files) == 1:
                ca_filter = ca_filter_parts[0].replace(ca_labels[0], '') + \
                    f',apad=whole_dur={total_video_dur:.3f}[clip_mix]'
            else:
                ca_filter = ';'.join(ca_filter_parts) + \
                    f';{"".join(ca_labels)}amix=inputs={len(clip_audio_files)}' \
                    f':duration=longest:normalize=0,' \
                    f'apad=whole_dur={total_video_dur:.3f}[clip_mix]'
            try:
                subprocess.run([
                    ffmpeg_path, '-y'] + ca_input_args + [
                    '-filter_complex', ca_filter,
                    '-map', '[clip_mix]',
                    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                    clip_audio_combined
                ], check=True, capture_output=True)
                has_clip_audio = True
                print(
                    f"  Clip audio combined (adelay): {len(clip_audio_files)} tracks")
            except subprocess.CalledProcessError as e:
                print(f"  Warning: clip audio combination failed: "
                      f"{e.stderr.decode()[:200]}")

    # ── 3. Gapped narration ─────────────────────────────────────
    gapped_narration_path = os.path.join(temp_dir, "gapped_narration.wav")
    narration_word_timestamps = clip_assembly_data.get(
        'narration_word_timestamps', [])
    text_segments = clip_assembly_data.get('text_segments', [])

    # Cumulative sums of original STT durations (fallback cut points)
    narr_cuts = [0.0]
    for d in original_stt_durations:
        narr_cuts.append(narr_cuts[-1] + d)

    narr_duration = get_audio_duration(audio_local_path)

    # ── Build speech time ranges (needed for both gapped narration and clip vol) ──
    speech_time_ranges = []
    current_time = 0.0
    for si, ad in enumerate(actual_durations):
        if si < len(has_speech) and has_speech[si]:
            speech_time_ranges.append(
                (current_time, current_time + ad))
        if use_transitions and transition_duration > 0 \
                and si < len(actual_durations) - 1:
            current_time += ad - transition_duration
        else:
            current_time += ad

    if narration_word_timestamps and text_segments:
        # ── Punctuation-snap gapped narration (matching SSAIVidGen.py) ──
        # Build speech groups: contiguous runs of speech clips
        speech_groups = []
        _i = 0
        while _i < len(has_speech):
            if has_speech[_i]:
                sg_start = _i
                while _i < len(has_speech) and has_speech[_i]:
                    _i += 1
                speech_groups.append((sg_start, _i - 1))
            else:
                _i += 1

        # Merge overlapping/adjacent speech time ranges
        if not speech_time_ranges:
            speech_time_ranges = [(0, 0)]  # placeholder
        sorted_ranges = sorted(speech_time_ranges)
        merged_ranges = [list(sorted_ranges[0])]
        for rs, re_val in sorted_ranges[1:]:
            if rs <= merged_ranges[-1][1] + 0.05:
                merged_ranges[-1][1] = max(merged_ranges[-1][1], re_val)
            else:
                merged_ranges.append([rs, re_val])
        merged_ranges = [(s, e) for s, e in merged_ranges]

        narr_pos = 0.0
        narr_segments_list = []
        accum_silence = 0.0
        print(f"\n  🔇 Creating gapped narration "
              f"({len(speech_groups)} pause regions, "
              f"punctuation-snap)...")

        for gi, ((g_start, g_end), (gs, ge)) in enumerate(
                zip(speech_groups, merged_ranges)):
            # ── Text-based cut point ─────────────────────────────
            fallback = narr_cuts[g_end + 1] \
                if g_end + 1 < len(narr_cuts) else narr_cuts[-1]
            snapped = None
            last_word = None

            if text_segments and g_end < len(text_segments):
                seg_w = text_segments[g_end].split()
                nm = min(3, len(seg_w))
                sw = [re.sub(r'[^\w]', '', w).lower()
                      for w in seg_w[-nm:]]
                for wi in range(len(narration_word_timestamps)):
                    wt = narration_word_timestamps[wi]
                    if wt['end'] <= narr_pos + 0.01:
                        continue
                    cw = re.sub(r'[^\w]', '', wt['word']).lower()
                    if cw == sw[-1]:
                        ok = True
                        for bk in range(1, nm):
                            pi = wi - bk
                            if pi < 0:
                                ok = False
                                break
                            pw = re.sub(
                                r'[^\w]', '',
                                narration_word_timestamps[pi]
                                ['word']).lower()
                            if pw != sw[-(1 + bk)]:
                                ok = False
                                break
                        if ok:
                            snapped = wt['end']
                            last_word = wt['word']
                            break

            if snapped is None:
                # Fallback to cumulative STT snap
                snapped = fallback
                for wt in narration_word_timestamps:
                    if wt['end'] <= fallback + 0.05:
                        snapped = wt['end']
                        last_word = wt['word']
                    elif wt['start'] > fallback + 0.1:
                        break
                print(f"    ⚠️  Text match failed for seg "
                      f"{g_end+1}, using STT fallback")

            # ── Punctuation snap: prefer cutting at .,!?;: ±7 words ──
            if snapped is not None and text_segments:
                snap_wi = None
                min_d = 1.0
                for pi2 in range(len(narration_word_timestamps)):
                    pwt = narration_word_timestamps[pi2]
                    dd = abs(pwt['end'] - snapped)
                    if dd < min_d:
                        min_d = dd
                        snap_wi = pi2
                if snap_wi is not None:
                    raw_near = ''
                    if g_end < len(text_segments):
                        raw_near += ' ' + text_segments[g_end]
                    if g_end + 1 < len(text_segments):
                        raw_near += ' ' + text_segments[g_end + 1]
                    raw_near = raw_near.lower().strip()

                    best_dist = 999
                    best_snap = None
                    best_word = None
                    for off in range(-7, 8):
                        ci = snap_wi + off
                        if ci < 0 or ci >= len(
                                narration_word_timestamps):
                            continue
                        cwt = narration_word_timestamps[ci]
                        if cwt['end'] <= narr_pos + 0.01:
                            continue
                        bare = re.sub(
                            r'[^\w]', '', cwt['word']).lower()
                        if not bare:
                            continue
                        pp = re.compile(
                            r'(?<!\w)' + re.escape(bare)
                            + r'[.,!?;:]', re.IGNORECASE)
                        matched = bool(pp.search(raw_near))
                        if matched and abs(off) < best_dist:
                            best_dist = abs(off)
                            best_snap = cwt['end']
                            best_word = cwt['word']
                    if best_snap is not None \
                            and best_snap != snapped:
                        print(f"    📌 Punctuation snap: "
                              f'"{last_word}" → "{best_word}" '
                              f"({best_dist} words away)")
                        snapped = best_snap
                        last_word = best_word

            # ── Fade last 2 words + tail before silence ──────────
            TAIL = 0.15
            fw2 = None  # 2nd-to-last word start
            fw1 = None  # last word start
            wir = [wt for wt in narration_word_timestamps
                   if wt['start'] >= narr_pos - 0.05
                   and wt['end'] <= snapped + 0.05]
            if len(wir) >= 2:
                fw2 = wir[-2]['start']
                fw1 = wir[-1]['start']

            trim_end = snapped + TAIL if fw2 else snapped

            if trim_end > narr_pos + 0.01:
                if fw2 is not None:
                    narr_segments_list.append(
                        ('trim', narr_pos, trim_end, fw2, fw1,
                         None, None))  # last 2 = fade-out info
                else:
                    narr_segments_list.append(
                        ('trim', narr_pos, trim_end))

            # Silence bridges from cut point in gapped timeline to ge
            gapped_pos = trim_end + accum_silence
            silence_dur = ge - gapped_pos
            if use_transitions and transition_duration > 0:
                silence_dur += transition_duration
            silence_dur = max(silence_dur, 0.01)
            accum_silence += silence_dur
            if silence_dur > 0.01:
                narr_segments_list.append(('silence', silence_dur))

            w_info = f' (after "{last_word}")' if last_word else ''
            print(f"  Pause {gi+1}: narration @ {snapped:.2f}s"
                  f"{w_info}, silence {silence_dur:.1f}s "
                  f"(video {gs:.1f}–{ge:.1f}s, "
                  f"segments {g_start+1}–{g_end+1})")
            narr_pos = trim_end

        # Remaining narration after last gap
        if narr_pos < narr_duration - 0.01:
            narr_segments_list.append(('trim', narr_pos, narr_duration))

        # ── Add fade-in info to trim segments after silence ──────
        for si3 in range(len(narr_segments_list)):
            if narr_segments_list[si3][0] != 'trim':
                continue
            # Check if preceded by a silence
            if si3 == 0 or narr_segments_list[si3 - 1][0] != 'silence':
                continue
            tseg = narr_segments_list[si3]
            t_start = tseg[1]
            t_end = tseg[2]
            # Find first 2 words in this trim range
            fwi = [wt for wt in narration_word_timestamps
                   if wt['start'] >= t_start - 0.05
                   and wt['end'] <= t_end + 0.05]
            if len(fwi) >= 2:
                fi1_end = fwi[0]['end']   # end of 1st word
                fi2_end = fwi[1]['end']   # end of 2nd word
                if len(tseg) == 7:
                    # Already has fade-out info — add fade-in
                    narr_segments_list[si3] = (
                        tseg[0], tseg[1], tseg[2],
                        tseg[3], tseg[4],
                        fi1_end, fi2_end)
                else:
                    # No fade-out — make 7-tuple with fade-in only
                    narr_segments_list[si3] = (
                        'trim', t_start, t_end,
                        None, None,
                        fi1_end, fi2_end)

        # Build ffmpeg filter: atrim segments + silence + concat
        # Trim tuple format (7-tuple):
        #   (0)='trim', (1)=start, (2)=end,
        #   (3)=fade-out 2nd-last word start, (4)=fade-out last word start,
        #   (5)=fade-in 1st word end, (6)=fade-in 2nd word end
        #   None values mean no fade on that side.
        fparts = []
        flabels = []
        for si2, seg in enumerate(narr_segments_list):
            lbl = f'[n{si2}]'
            if seg[0] == 'trim':
                ts, te = seg[1], seg[2]
                tdur = te - ts
                has_fadeout = (len(seg) >= 5
                               and seg[3] is not None)
                has_fadein = (len(seg) >= 7
                              and seg[5] is not None)

                if has_fadeout or has_fadein:
                    # Build volume expression combining fade-in + fade-out
                    vol_parts = []
                    if has_fadein:
                        fi1 = seg[5] - ts  # end of 1st word
                        fi2 = seg[6] - ts  # end of 2nd word
                        vol_parts.append(
                            f'lt(t,{fi1:.3f}),0.4')
                        vol_parts.append(
                            f'gte(t,{fi1:.3f})*lt(t,{fi2:.3f}),0.6')
                    if has_fadeout:
                        w2l = seg[3] - ts
                        w1l = seg[4] - ts
                        vol_parts.append(
                            f'gte(t,{w2l:.3f})*lt(t,{w1l:.3f}),0.8')
                        vol_parts.append(
                            f'gte(t,{w1l:.3f}),0.6')

                    # Build nested if chain
                    vol_expr = '1.0'
                    for vp in reversed(vol_parts):
                        cond, val = vp.rsplit(',', 1)
                        vol_expr = (f'if({cond},{val},'
                                    f'{vol_expr})')

                    chain = (f'[0:a]atrim={ts:.3f}:{te:.3f},'
                             f'asetpts=PTS-STARTPTS,'
                             f"volume='{vol_expr}':eval=frame")
                    if has_fadein:
                        chain += (f',afade=t=in:st=0'
                                  f':d=0.15')
                    if has_fadeout:
                        chain += (f',afade=t=out'
                                  f':st={tdur - 0.15:.3f}'
                                  f':d=0.15')
                    fparts.append(f'{chain}{lbl}')
                else:
                    fparts.append(
                        f'[0:a]atrim={ts:.3f}:{te:.3f},'
                        f'asetpts=PTS-STARTPTS{lbl}')
            else:
                fparts.append(
                    f'anullsrc=channel_layout=mono:sample_rate=48000,'
                    f'atrim=0:{seg[1]:.3f},asetpts=PTS-STARTPTS{lbl}')
            flabels.append(lbl)

        narr_filter = ';'.join(fparts) + \
            f';{"".join(flabels)}concat=n={len(flabels)}:v=0:a=1[gapped]'

    else:
        # ── Fallback: per-segment gapped narration (no word timestamps) ──
        print("  ⚠️  No word timestamps available, "
              "using per-segment cuts")
        narr_seg_parts = []
        narr_labels = []
        for i in range(len(actual_durations)):
            label = f'[ns{i}]'
            speech = has_speech[i] if i < len(has_speech) else False
            dur = actual_durations[i]

            if speech:
                narr_seg_parts.append(
                    f'anullsrc=channel_layout=mono:'
                    f'sample_rate=48000,'
                    f'atrim=0:{dur:.3f},'
                    f'asetpts=PTS-STARTPTS{label}')
            else:
                start = narr_cuts[i] \
                    if i < len(narr_cuts) else narr_cuts[-1]
                end = narr_cuts[i + 1] \
                    if i + 1 < len(narr_cuts) else start + dur
                narr_seg_parts.append(
                    f'[0:a]atrim={start:.3f}:{end:.3f},'
                    f'asetpts=PTS-STARTPTS{label}')
            narr_labels.append(label)

        narr_filter = ';'.join(narr_seg_parts) + \
            f';{"".join(narr_labels)}concat=n={len(narr_labels)}' \
            f':v=0:a=1[gapped]'

    try:
        subprocess.run([
            ffmpeg_path, '-y', '-i', audio_local_path,
            '-filter_complex', narr_filter,
            '-map', '[gapped]',
            '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
            gapped_narration_path
        ], check=True, capture_output=True)
        gapped_dur = get_audio_duration(gapped_narration_path)
        audio_dur = get_audio_duration(audio_local_path)
        print(f"  Gapped narration: {gapped_dur:.1f}s "
              f"(original: {audio_dur:.1f}s, "
              f"+{gapped_dur - audio_dur:.1f}s gaps)")
    except subprocess.CalledProcessError as e:
        print(f"  Gapped narration FAILED: {e.stderr.decode()[:300]}")
        return False

    # ── 4. Final mix ────────────────────────────────────────────
    # Build speech-aware clip volume expression (matching SSAIVidGen.py)
    clip_vol_expr = ''
    if speech_time_ranges and has_clip_audio:
        between_expr = '+'.join(
            f'between(t,{s:.3f},{e:.3f})' for s, e in speech_time_ranges
        )
        clip_vol_expr = (
            f"volume='if({between_expr},1.0,0.8)':eval=frame,")
    elif has_clip_audio:
        clip_vol_expr = 'volume=0.8,'

    try:
        if has_clip_audio and bg_music_local_path:
            # 2-pass approach (matching SSAIVidGen.py):
            # Pass 1: mix gapped narration + clip audio into video
            # Pass 2: mix background music on top (preserves narration volume)
            intermediate_path = os.path.join(temp_dir, "speech_no_bg.mp4")
            subprocess.run([
                ffmpeg_path, '-y',
                '-i', concatenated_video_path,
                '-i', gapped_narration_path,
                '-i', clip_audio_combined,
                '-filter_complex',
                f'[1:a]apad=whole_dur={total_video_dur:.3f}[narr];'
                f'[2:a]{clip_vol_expr}apad=whole_dur={total_video_dur:.3f}[clip];'
                f'[narr][clip]amix=inputs=2:duration=first:normalize=0[aout]',
                '-map', '0:v:0', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                '-y', intermediate_path
            ], check=True, capture_output=True)
            print("  Pass 1: gapped narration + clip audio ✓")

            # Pass 2: mix background music (matching SSAIVidGen.py mix_background_music)
            subprocess.run([
                ffmpeg_path, '-y',
                '-i', intermediate_path,
                '-i', bg_music_local_path,
                '-filter_complex',
                f'[0:a]volume=1.0[narr];'
                f'[1:a]volume={bg_music_volume},aloop=loop=-1:size=2e+09[music];'
                f'[narr][music]amix=inputs=2:duration=first:dropout_transition=3:normalize=0[aout]',
                '-map', '0:v:0', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                '-y', final_video_path
            ], check=True, capture_output=True)
            print("  Pass 2: background music mixed ✓")

            # Clean up intermediate file
            if os.path.exists(intermediate_path):
                os.remove(intermediate_path)

        elif has_clip_audio:
            # 2-way: gapped narration + clip audio
            subprocess.run([
                ffmpeg_path, '-y',
                '-i', concatenated_video_path,
                '-i', gapped_narration_path,
                '-i', clip_audio_combined,
                '-filter_complex',
                f'[1:a]apad=whole_dur={total_video_dur:.3f}[narr];'
                f'[2:a]{clip_vol_expr}apad=whole_dur={total_video_dur:.3f}[clip];'
                f'[narr][clip]amix=inputs=2:duration=first:normalize=0[aout]',
                '-map', '0:v:0', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-ar', '44100', '-ac', '2',
                '-movflags', '+faststart',
                '-y', final_video_path
            ], check=True, capture_output=True)
            print("  Final: gapped narration + clip audio ✓")

        else:
            # Gapped narration only (no clip audio extracted)
            subprocess.run([
                ffmpeg_path, '-y',
                '-i', concatenated_video_path,
                '-i', gapped_narration_path,
                '-filter_complex',
                f'[1:a]apad=whole_dur={total_video_dur:.3f}[aout]',
                '-map', '0:v:0', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-ar', '44100', '-ac', '2',
                '-avoid_negative_ts', 'make_zero', '-fflags', '+genpts',
                '-movflags', '+faststart',
                '-y', final_video_path
            ], check=True, capture_output=True)
            print("  Final: gapped narration (no clip audio) ✓")

        return True

    except subprocess.CalledProcessError as e:
        print(f"  Speech audio assembly FAILED: {e.stderr.decode()[:300]}")
        return False


def concatenate_videos_simple(local_video_files, output_path):
    """Simple video concatenation without transitions using concat demuxer.

    The individual videos are already produced by image-to-video-processor
    with consistent settings (1920×1080, 30 fps, yuv420p, libx264), so NO
    re-encoding or normalization is needed.  We just use the FFmpeg concat
    demuxer with -c copy which is near-instant and uses no extra disk space.
    """
    ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

    try:
        if len(local_video_files) == 1:
            import shutil
            shutil.copy2(local_video_files[0], output_path)
            print("Single video copied as concatenated video")
        else:
            temp_dir = os.path.dirname(output_path)
            concat_list_path = os.path.join(temp_dir, 'concat_list.txt')

            with open(concat_list_path, 'w') as f:
                for video_file in local_video_files:
                    f.write(f"file '{video_file}'\n")

            print(
                f"Concatenating {len(local_video_files)} videos with concat demuxer (copy, no re-encode)...")
            subprocess.run([
                ffmpeg_path, '-y',
                '-f', 'concat', '-safe', '0', '-i', concat_list_path,
                '-c', 'copy',
                '-movflags', '+faststart',
                output_path
            ], check=True, capture_output=True)
            print("Video concatenation complete (concat demuxer, copy mode)")

            try:
                os.remove(concat_list_path)
            except OSError:
                pass

        return True

    except subprocess.CalledProcessError as e:
        print(f"FFmpeg simple concatenation error: {e.stderr.decode()}")
        return False
    except subprocess.TimeoutExpired:
        print("Video concatenation timed out")
        return False


def concatenate_videos_with_transitions(local_video_files, output_path, transition_type, transition_duration, video_durations):
    """Video concatenation with transitions using xfade"""
    ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

    try:
        if len(local_video_files) == 1:
            # Only one video, just copy it
            import shutil
            shutil.copy2(local_video_files[0], output_path)
            print("Single video copied (transitions not needed)")
            return True

        print(
            f"Creating video with {transition_type} transitions of {transition_duration}s duration")

        # Build input args
        input_args = []
        for video in local_video_files:
            input_args.extend(['-i', video])

        # Build filter_complex for chained transitions
        # First normalize every input: reset timestamps, force yuv420p, constant 30 fps
        # This prevents xfade failures caused by VFR clips or mismatched pixel formats
        filter_complex = []
        for idx in range(len(local_video_files)):
            filter_complex.append(
                f'[{idx}:v]scale=1920:1080:flags=bilinear,setpts=PTS-STARTPTS,fps=60,format=yuv420p[v{idx}]'
            )

        prev = '[v0]'
        current_length = video_durations[0]

        for i in range(1, len(local_video_files)):
            offset = current_length - transition_duration
            tmp_label = f'[tmp{i}]'
            filter_complex.append(
                f'{prev}[v{i}]xfade=transition={transition_type}:duration={transition_duration}:offset={offset}{tmp_label}'
            )
            prev = tmp_label
            current_length += video_durations[i] - transition_duration

        filter_complex_str = ';'.join(filter_complex)

        # Final ffmpeg command for transitions
        # -an strips any residual audio tracks from TTV/ITV clips
        concat_cmd = [ffmpeg_path, '-y'] + input_args + [
            '-filter_complex', filter_complex_str,
            '-map', prev, '-an',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            output_path
        ]

        subprocess.run(concat_cmd, check=True,
                       capture_output=True)
        print(
            f"Video concatenation with {transition_type} transitions complete")
        return True

    except subprocess.CalledProcessError as e:
        stderr_text = e.stderr.decode()
        # Print only the LAST 2000 chars — the actual error is at the end,
        # the version header at the start is noise.
        if len(stderr_text) > 2000:
            print(
                f"FFmpeg transition error (last 2000 chars): ...{stderr_text[-2000:]}")
        else:
            print(f"FFmpeg transition concatenation error: {stderr_text}")
        return False
    except subprocess.TimeoutExpired:
        print("Video concatenation with transitions timed out")
        return False


def process_transition_batches_internal(supabase, video_task_id, user_id, group_id, individual_videos_paths, transition_type, transition_duration, temp_dir, continue_from_batch=1, tab=1, visual_type='image'):
    """Process up to 1 transition batch internally, then trigger continuation if needed."""
    try:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # Constants - batch size: 12 for TTV/ITV, 6 for images
        BATCH_SIZE = 12 if visual_type in ('ttv', 'itv') else 6
        MAX_BATCHES_PER_RUN = 1  # Process only 1 batch per run

        total_videos = len(individual_videos_paths)
        total_batches = (total_videos + BATCH_SIZE - 1) // BATCH_SIZE

        print(
            f"Processing transition batches starting from batch {continue_from_batch}")
        print(
            f"Total videos: {total_videos}, Total batches: {total_batches}, Batch size: {BATCH_SIZE}")

        # Calculate which batches to process in this run
        end_batch = min(continue_from_batch +
                        MAX_BATCHES_PER_RUN - 1, total_batches)
        batches_to_process = list(range(continue_from_batch, end_batch + 1))

        print(f"Processing batches: {batches_to_process}")

        # Process each batch (should be just 1 batch now)
        batch_outputs = []
        for batch_num in batches_to_process:
            print(f"Processing batch {batch_num}/{total_batches}")

            # Calculate video range for this batch
            start_idx = (batch_num - 1) * BATCH_SIZE
            end_idx = min(start_idx + BATCH_SIZE, total_videos)

            # Only download videos needed for THIS batch (not all videos)
            batch_video_paths = individual_videos_paths[start_idx:end_idx]
            batch_videos = []
            for dl_idx, video_path in enumerate(batch_video_paths, start=start_idx + 1):
                local_path = os.path.join(temp_dir, f"video_{dl_idx:03d}.mp4")
                download_url = f"{supabase_url}/storage/v1/object/videos/{video_path}"

                if download_file(download_url, local_path, headers):
                    batch_videos.append(local_path)
                    print(f"Downloaded video {dl_idx}")
                else:
                    raise Exception(
                        f"Failed to download video {dl_idx}")

            print(
                f"Batch {batch_num}: processing videos {start_idx+1} to {end_idx} ({len(batch_videos)} videos)")

            # Get video durations
            video_durations = []
            for video_file in batch_videos:
                duration = get_video_duration(video_file)
                video_durations.append(duration)

            # Process batch with transitions
            batch_output_path = os.path.join(
                temp_dir, f"batch_{batch_num}.mp4")

            success = concatenate_videos_with_transitions(
                batch_videos, batch_output_path, transition_type, transition_duration, video_durations)

            if not success:
                raise Exception(f"Failed to process batch {batch_num}")

            # Upload batch result to transition_batches folder
            batch_upload_path = f"videos/{user_id}/{group_id}/transition_batches/batch_{batch_num}.mp4"

            # TUS UPLOAD RETRY IMPLEMENTATION
            if not upload_file_to_supabase(supabase, batch_output_path, batch_upload_path, 'videos', 'video/mp4'):
                print(
                    f"Upload failed for batch {batch_num}, triggering retry via edge function")
                try:
                    requests.post(
                        f"{supabase_url}/functions/v1/process-transition-batches",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                            "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                        },
                        json={
                            "video_task_id": video_task_id,
                            "user_id": user_id,
                            "group_id": group_id,
                            "continue_from_batch": batch_num,
                            "transition_type": transition_type,
                            "transition_duration": transition_duration,
                            "tab": tab
                        },
                    )
                    return {
                        "status": "retry_triggered",
                        "failed_batch": batch_num,
                        "message": f"Upload failed for batch {batch_num}, retry triggered"
                    }
                except Exception as retry_error:
                    print(f"Failed to trigger retry: {str(retry_error)}")
                    raise Exception(
                        f"Failed to upload batch {batch_num} and retry trigger failed")

            batch_outputs.append(batch_upload_path)
            print(f"Batch {batch_num} completed and uploaded")

        # Get existing progress and update with new batch outputs
        task_result = supabase.table("video_tasks").select(
            "transition_batch_progress").eq("id", video_task_id).single().execute()

        existing_progress = task_result.data.get(
            "transition_batch_progress", {}) if task_result.data else {}
        existing_batch_outputs = existing_progress.get("batch_outputs", [])

        # Combine existing and new batch outputs
        all_batch_outputs = existing_batch_outputs + batch_outputs

        # Update progress in database
        progress_data = {
            "total_batches": total_batches,
            "completed_batches": end_batch,
            "batch_outputs": all_batch_outputs,
            "total_videos": total_videos
        }

        supabase.table("video_tasks").update({
            "transition_batch_progress": progress_data,
            "updated_at": "now()"
        }).eq("id", video_task_id).execute()

        print(
            f"Updated progress: completed {end_batch}/{total_batches} batches")

        # Check if we need to continue or if we're done
        if end_batch < total_batches:
            # More batches to process - trigger continuation
            print(
                f"Triggering continuation for batch {end_batch + 1}")

            try:
                resp = requests.post(
                    f"{supabase_url}/functions/v1/process-transition-batches",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                        "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                    },
                    json={
                        "video_task_id": video_task_id,
                        "user_id": user_id,
                        "group_id": group_id,
                        "continue_from_batch": end_batch + 1,
                        "transition_type": transition_type,
                        "transition_duration": transition_duration,
                        "tab": tab
                    },
                )
                print(
                    f"Triggered batch processing continuation (edge fn status: {resp.status_code})")
            except requests.exceptions.Timeout:
                print(
                    "Edge function trigger timed out — continuation should still proceed")
            except Exception as e:
                print(
                    f"Fire-and-forget trigger for batch processing continuation: {str(e)}")

            return {
                "status": "continuing",
                "processed_batches": batches_to_process,
                "next_batch": end_batch + 1,
                "total_batches": total_batches
            }
        else:
            # All batches processed - ready for final assembly
            print("All transition batches completed")
            return {
                "status": "completed",
                "processed_batches": batches_to_process,
                "total_batches": total_batches,
                "batch_outputs": all_batch_outputs
            }

    except Exception as e:
        print(f"Error in transition batch processing: {str(e)}")
        raise e


def final_assembly_from_transition_batches(supabase, video_task_id, user_id, group_id, temp_dir):
    """Assemble final video from completed transition batches"""
    try:
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        print("Starting final assembly from transition batches")

        # Get task details to find batch outputs
        task_result = supabase.table("video_tasks").select(
            "transition_batch_progress").eq("id", video_task_id).single().execute()
        if not task_result.data:
            raise Exception("Video task not found")

        # Handle different response formats
        if isinstance(task_result.data, list) and len(task_result.data) > 0:
            task_data = task_result.data[0]
        elif isinstance(task_result.data, dict):
            task_data = task_result.data
        else:
            raise Exception("Invalid task data format")

        progress = task_data.get("transition_batch_progress", {})
        batch_outputs = progress.get("batch_outputs", [])
        total_batches = progress.get("total_batches", 0)

        print(f"Found {len(batch_outputs)} batch outputs for assembly")

        if not batch_outputs:
            raise Exception("No batch outputs found for final assembly")

        if len(batch_outputs) != total_batches:
            print(
                f"Warning: Expected {total_batches} batches but found {len(batch_outputs)}")

        # Download all batch files
        local_batch_files = []
        for idx, batch_path in enumerate(batch_outputs, 1):
            local_batch_path = os.path.join(temp_dir, f"batch_{idx}.mp4")
            download_url = f"{supabase_url}/storage/v1/object/videos/{batch_path}"

            if download_file(download_url, local_batch_path, headers):
                local_batch_files.append(local_batch_path)
                print(f"Downloaded batch {idx}")
            else:
                raise Exception(f"Failed to download batch {idx}")

        if not local_batch_files:
            raise Exception("No batch files downloaded")

        # Simple concatenation of batch outputs (no transitions between batches)
        concatenated_video_path = os.path.join(temp_dir, "concatenated.mp4")

        if not concatenate_videos_simple(local_batch_files, concatenated_video_path):
            raise Exception("Failed to concatenate batch outputs")

        print("Transition batches assembled successfully")
        return concatenated_video_path

    except Exception as e:
        print(f"Error in final assembly: {str(e)}")
        raise e


def sanitize_filename(filename):
    """Enhanced filename sanitization with Unicode normalization and transliteration"""
    try:
        # First, normalize Unicode characters to decomposed form (NFD)
        filename = unicodedata.normalize('NFD', filename)

        # Remove combining characters (accents) - this converts ó → o, ñ → n, etc.
        filename = ''.join(
            c for c in filename if unicodedata.category(c) != 'Mn')

        # Convert to ASCII, replacing any remaining non-ASCII characters
        filename = filename.encode('ascii', 'ignore').decode('ascii')

        # Remove all non-alphanumeric, space, dash, dot chars
        filename = re.sub(r'[^\w\s.-]', '', filename)

        # Replace spaces and multiple dashes with single underscores
        filename = re.sub(r'[-\s]+', '_', filename)

        # Remove leading/trailing underscores and dots
        filename = filename.strip('_.')

        # Ensure filename is not empty after sanitization
        if not filename:
            filename = "video"

        # Limit filename length to avoid filesystem issues
        if len(filename) > 100:
            filename = filename[:100]

        print(f"Sanitized filename: '{filename}'")
        return filename

    except Exception as e:
        print(f"Error sanitizing filename: {str(e)}, using fallback")
        return "video"


# ── Async subtitle burn helpers ──────────────────────────────────────────────


def trigger_subtitle_burn_async(supabase_url, supabase_key, video_task_id,
                                user_id, group_id, tab=1, retry=False,
                                chunk_index=None, concat_chunks=False):
    """Fire-and-forget call back into create-final-video (via the
    process-transition-batches edge function so versioned routing is
    handled centrally) to run the subtitle burn step asynchronously.

    ``chunk_index`` (int) → dispatch a per-chunk burn invocation.
    ``concat_chunks`` (bool) → dispatch the final concat invocation.
    Setting neither runs the legacy single-shot burn (or the chunked
    dispatcher's first call, depending on payload size).
    Returns True if the trigger HTTP POST succeeded, False otherwise.
    """
    payload = {
        "video_task_id": video_task_id,
        "user_id": user_id,
        "group_id": group_id,
        "burn_subtitles_only": True,
        "burn_subtitles_retry": retry,
        "tab": tab,
    }
    if chunk_index is not None:
        payload["subtitle_chunk_index"] = int(chunk_index)
    if concat_chunks:
        payload["subtitle_concat_chunks"] = True
    try:
        requests.post(
            f"{supabase_url}/functions/v1/process-transition-batches",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
            },
            json=payload,
            timeout=10,
        )
        print(
            f"[subtitles] async burn trigger sent (retry={retry}, "
            f"chunk_index={chunk_index}, concat={concat_chunks})")
        return True
    except Exception as e:
        print(f"[subtitles] failed to trigger async burn: {e}")
        return False


def _download_final_video_for_burn(supabase_url, supabase_key, final_video_url,
                                   local_path):
    """Download an already-uploaded final video from the videos bucket."""
    try:
        # final_video_url is stored as the *path within the `videos` bucket*,
        # e.g. "videos/{user}/{group}/file.mp4" (the "videos/" prefix is part of
        # the object path, NOT the bucket name). The full storage REST URL is
        # `<base>/storage/v1/object/<bucket>/<path>`, so we must prepend the
        # bucket name `videos/` here. (See individual-video downloads in this
        # file which use the same `videos/<videos/...>` double-prefix pattern.)
        url = f"{supabase_url}/storage/v1/object/videos/{final_video_url}"
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
        with requests.get(url, headers=headers, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
        size = os.path.getsize(local_path)
        print(
            f"[subtitles] downloaded final video ({size} bytes) → {local_path}")
        return True
    except Exception as e:
        print(f"[subtitles] download failed: {e}")
        return False


def _mark_subtitles_completed(supabase, video_task_id, user_id, group_id, tab,
                              final_video_upload_path, final_video_local_path,
                              settings, subtitles_status='completed',
                              audio_path_for_cleanup=None,
                              supabase_url=None, supabase_key=None):
    """Common completion logic shared between subtitle-success and
    subtitle-failure paths: marks the task completed_final, inserts the
    story_documents metadata row, and runs storage cleanup."""
    try:
        file_size = os.path.getsize(
            final_video_local_path) if os.path.exists(final_video_local_path) else 0
        update_data = {
            "video_creation_status": "completed_final",
            "overall_status": "completed_final",
            "individual_video_status": "completed_final",
            "story_status": "completed_final",
            "image_prompt_status": "completed_final",
            "image_generation_status": "completed_final",
            "audio_status": "completed_final",
            "overall_progress": 100,
            "story_progress": 100,
            "image_prompt_progress": 100,
            "image_generation_progress": 100,
            "audio_progress": 100,
            "video_creation_progress": 100,
            "individual_video_progress": 100,
            "final_video_url": final_video_upload_path,
            "subtitles_status": subtitles_status,
            "completed_at": "now()",
            "updated_at": "now()",
        }
        supabase.table("video_tasks").update(
            update_data).eq("id", video_task_id).execute()
        # Mirror to all sibling batch tasks
        supabase.table("video_tasks").update({
            k: v for k, v in update_data.items()
            if k not in ("final_video_url", "subtitles_status", "completed_at")
        }).eq("user_id", user_id).eq("group_id", group_id).execute()

        try:
            next_variant = get_next_video_variant(
                supabase, user_id, group_id)
            supabase.table("story_documents").insert({
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "group_id": group_id,
                "created_at": "now()",
                "updated_at": "now()",
                "file_path": final_video_upload_path,
                "title": settings.get("story_title", "Final Video"),
                "description": "Final Video",
                "file_size": file_size,
                "variant": next_variant,
                "version": 11,
                "is_corrected": False,
                "is_prompted": False,
                "word_count": 0,
                "tab": tab,
            }).execute()
        except Exception as metadata_error:
            print(
                f"[subtitles] failed to insert story_documents metadata: {metadata_error}")

        if supabase_url and supabase_key and audio_path_for_cleanup is not None:
            try:
                cleanup_storage_after_completion(
                    supabase_url, supabase_key, user_id, group_id, audio_path_for_cleanup)
            except Exception as _e:
                print(f"[subtitles] cleanup failed: {_e}")
        try:
            delete_task_rows(supabase, user_id, group_id)
        except Exception as _e:
            print(f"[subtitles] delete_task_rows failed: {_e}")
        return True
    except Exception as e:
        print(f"[subtitles] _mark_subtitles_completed error: {e}")
        return False


# ── Chunked subtitle burn pipeline ---------------------------------------
# See subtitles.py:CHUNKED BURN PIPELINE for the high-level rationale.
# These helpers keep the storage / state-management glue out of subtitles.py
# (which only owns ffmpeg + .ass generation).

_SUBS_CHUNKS_PREFIX = "_subs_chunks"
# Tunables — keep each per-chunk invocation well under the 60-min Cloud
# Functions ceiling. ~40 min source per chunk → ~12-18 min libx264 burn on
# 4 vCPU + ~3 min download + ~2 min upload. Plenty of headroom.
_SUBS_TARGET_CHUNK_SEC = 1200.0  # 20 min source per chunk (~6-10 min libx264 burn, safe under 30 min wall)
_SUBS_MIN_CHUNK_SEC = 480.0      # never produce a tail < 8 min
_SUBS_CHUNK_THRESHOLD_SEC = 1500.0  # only chunk if total > 25 min


def _subs_chunks_dir(user_id: str, group_id: str, video_task_id: str) -> str:
    """Storage prefix (path within `videos` bucket) for per-chunk MP4s."""
    return f"videos/{user_id}/{group_id}/{_SUBS_CHUNKS_PREFIX}/{video_task_id}"


def _upload_chunk_to_storage(supabase, local_path: str, storage_path: str) -> bool:
    """Upsert a single seg_<i>.mp4 into the `videos` bucket."""
    try:
        with open(local_path, 'rb') as f:
            try:
                supabase.storage.from_("videos").upload(
                    storage_path, f,
                    {"content-type": "video/mp4", "x-upsert": "true"},
                )
            except Exception:
                try:
                    supabase.storage.from_("videos").remove([storage_path])
                except Exception:
                    pass
                with open(local_path, 'rb') as f2:
                    supabase.storage.from_("videos").upload(
                        storage_path, f2,
                        {"content-type": "video/mp4"},
                    )
        return True
    except Exception as e:
        print(f"[subtitles] chunk upload failed for {storage_path}: {e}")
        return False


def _download_chunk_from_storage(supabase_url, supabase_key,
                                 storage_path: str, local_path: str) -> bool:
    try:
        url = f"{supabase_url}/storage/v1/object/videos/{storage_path}"
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
        with requests.get(url, headers=headers, stream=True, timeout=300) as r:
            r.raise_for_status()
            with open(local_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
        return os.path.exists(local_path) and os.path.getsize(local_path) > 0
    except Exception as e:
        print(f"[subtitles] chunk download failed for {storage_path}: {e}")
        return False


def _delete_chunks_from_storage(supabase, storage_paths):
    if not storage_paths:
        return
    try:
        supabase.storage.from_("videos").remove(list(storage_paths))
    except Exception as e:
        print(f"[subtitles] chunk cleanup failed: {e}")


def _read_burn_state(supabase, video_task_id):
    try:
        row = supabase.table("video_tasks").select(
            "subtitle_burn_state").eq("id", video_task_id).single().execute()
        state = ((row.data or {}) if row else {}).get("subtitle_burn_state")
        if isinstance(state, str):
            try:
                state = json.loads(state)
            except Exception:
                state = None
        return state if isinstance(state, dict) else None
    except Exception as e:
        print(f"[subtitles] read burn state failed: {e}")
        return None


def _write_burn_state(supabase, video_task_id, state):
    try:
        supabase.table("video_tasks").update({
            "subtitle_burn_state": state,
            "updated_at": "now()",
        }).eq("id", video_task_id).execute()
    except Exception as e:
        print(f"[subtitles] write burn state failed: {e}")


def _clear_burn_state(supabase, video_task_id):
    try:
        supabase.table("video_tasks").update({
            "subtitle_burn_state": None,
            "subtitle_tokens_pending": 0,
            "updated_at": "now()",
        }).eq("id", video_task_id).execute()
    except Exception as e:
        print(f"[subtitles] clear burn state failed: {e}")


def trigger_retry_via_edge_function(supabase_url, supabase_key, video_task_id, user_id, group_id, tab=1):
    """Trigger retry via process-transition-batches edge function"""
    try:
        print("Final video upload failed, triggering retry via process-transition-batches")

        # Check if transitions are being used by checking the database
        supabase: Client = create_client(supabase_url, supabase_key)

        # Get the task to check if transitions exist
        task_result = supabase.table("video_tasks").select(
            "transition_type").eq("id", video_task_id).single().execute()

        # Determine if final assembly should be used based on whether transitions exist
        has_transitions = False
        if task_result.data:
            # Handle different response formats
            if isinstance(task_result.data, list) and len(task_result.data) > 0:
                task_data = task_result.data[0]
            elif isinstance(task_result.data, dict):
                task_data = task_result.data
            else:
                task_data = {}

            transition_type = task_data.get("transition_type")
            has_transitions = transition_type is not None and transition_type.strip(
            ) if transition_type else False

        print(f"Retry logic: transitions detected = {has_transitions}")

        requests.post(
            f"{supabase_url}/functions/v1/process-transition-batches",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
            },
            json={
                "video_task_id": video_task_id,
                "user_id": user_id,
                "group_id": group_id,
                "final_assembly": has_transitions,  # Only use final assembly if transitions exist
                "tab": tab
            }
        )
        print("Triggered retry via process-transition-batches")
        return True
    except Exception as retry_error:
        print(f"Failed to trigger retry: {str(retry_error)}")
        return False


@functions_framework.http
@billed("create-final-video-high-memory", _GCF_SUFFIX)
def create_final_video_high_memory(request):
    # Verify SERVICE_ROLE_KEY authentication
    if not verify_service_role_key(request):
        return add_cors_headers(request, {"error": "Unauthorized: Invalid or missing SERVICE_ROLE_KEY"}, 401)
    """Handle HTTP requests for creating final video from individual videos and audio with optional background music"""

    if request.method == "OPTIONS":
        return add_cors_headers(request, {})

    if request.method != "POST":
        return add_cors_headers(request, {"error": "Method not allowed"}, 405)

    try:
        print("Starting final video creation process with background music and video loop support")

        # Parse request
        data = request.get_json(silent=True)
        if not data:
            return add_cors_headers(request, {"error": "Invalid JSON body"}, 400)

        video_task_id = data.get("video_task_id")
        user_id = data.get("user_id")
        group_id = data.get("group_id")
        individual_videos_paths = data.get("individual_videos_paths", [])
        tab = data.get("tab", 1)  # Default to tab 1 for non-enterprise users

        # NEW: Check for batch processing continuation
        continue_batch_processing = data.get(
            "continue_batch_processing", False)
        continue_from_batch = data.get("continue_from_batch", 1)
        final_assembly_flag = data.get("final_assembly", False)

        # Get transition parameters - handle None/null values properly
        transition_duration = data.get("transition_duration", 0.5)
        transition_type = data.get("transition_type")  # This can be None/null

        # Determine if transitions should be used
        use_transitions = transition_type is not None and transition_type.strip(
        ) if transition_type else False

        if use_transitions:
            print(
                f"Transitions enabled: {transition_type} with duration: {transition_duration}s")
        else:
            print("Transitions disabled - using simple concatenation")

        if not all([video_task_id, user_id, group_id]):
            return add_cors_headers(request, {"error": "Missing required parameters"}, 400)

        # Initialize Supabase
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        if not supabase_url or not supabase_key:
            return add_cors_headers(request, {"error": "Server configuration error - missing Supabase credentials"}, 500)

        supabase: Client = create_client(supabase_url, supabase_key)

        # ── Runtime-log metadata ────────────────────────────────────────
        # Pull the work-shape fields off video_tasks once so the runtime
        # log row tells us how big a job this was (audio length, image
        # count, transitions, subtitles). Used to calibrate the
        # `tFinalRender` / `tSubtitles` constants in timeEstimates.ts.
        try:
            _meta_row = supabase.table("video_tasks").select(
                "total_audio_duration, total_individual_videos, image_amount, "
                "visual_type, transition_type, animation_type, effects_type, "
                "subtitles, settings, video_loop"
            ).eq("id", video_task_id).single().execute()
            _meta_task = (_meta_row.data or {}) if _meta_row else {}
            _meta_settings = _meta_task.get("settings") or {}
            if isinstance(_meta_settings, str):
                try:
                    import json as _json
                    _meta_settings = _json.loads(_meta_settings)
                except Exception:
                    _meta_settings = {}
            add_billing_metadata(
                request,
                visual_type=_meta_task.get(
                    "visual_type") or _meta_settings.get("visual_type"),
                total_audio_duration=_meta_task.get("total_audio_duration"),
                total_individual_videos=_meta_task.get(
                    "total_individual_videos"),
                image_amount=_meta_task.get("image_amount"),
                has_transitions=bool(_meta_task.get("transition_type")),
                transition_type=_meta_task.get("transition_type"),
                has_overlay=bool(_meta_task.get("animation_type")) or bool(
                    _meta_task.get("effects_type")),
                animation_type=_meta_task.get("animation_type"),
                effects_type=_meta_task.get("effects_type"),
                has_subtitles=bool(_meta_task.get("subtitles")),
                use_existing_audio=bool(
                    _meta_settings.get("use_existing_audio")),
                has_video_loop=bool(_meta_task.get("video_loop")),
                burn_subtitles_only=bool(data.get("burn_subtitles_only")),
                continue_batch_processing=bool(continue_batch_processing),
                final_assembly=bool(final_assembly_flag),
                use_high_memory=True,
                gcf_suffix=_GCF_SUFFIX,
                num_individual_videos=len(individual_videos_paths or []),
            )
        except Exception as _meta_err:
            print(f"[metadata] create-final-video-high-memory: {_meta_err}")

        # ── Mode: burn subtitles only ────────────────────────────────
        # Triggered as a fire-and-forget call AFTER the un-subtitled video
        # has been uploaded. Downloads the final video, burns subtitles,
        # re-uploads, charges per-minute tokens, then runs the same
        # completion bookkeeping (story_documents + cleanup) the normal
        # path does. Independent of transition/effects pipelines.
        if data.get("burn_subtitles_only"):
            burn_retry = bool(data.get("burn_subtitles_retry", False))
            chunk_index = data.get("subtitle_chunk_index")
            is_concat = bool(data.get("subtitle_concat_chunks"))
            is_high_memory = '-high-memory' in (_GCF_SUFFIX or '') or os.getenv(
                'GCF_HIGH_MEMORY') == '1'
            print(
                f"[subtitles] burn_subtitles_only mode (retry={burn_retry}, "
                f"high_memory={is_high_memory}, chunk_index={chunk_index}, "
                f"concat={is_concat})")

            try:
                supabase.table("video_tasks").update({
                    "subtitles_status": "processing",
                    "updated_at": "now()",
                }).eq("id", video_task_id).execute()
            except Exception as _e:
                print(f"[subtitles] could not set processing status: {_e}")

            # Load the task to get final_video_url + settings
            task_row = supabase.table("video_tasks").select(
                "final_video_url, settings, subtitles"
            ).eq("id", video_task_id).single().execute()
            task_data = (task_row.data or {}) if task_row else {}
            final_video_url = task_data.get("final_video_url")
            task_settings = task_data.get("settings") or {}
            if isinstance(task_settings, str):
                try:
                    task_settings = json.loads(task_settings)
                except Exception:
                    task_settings = {}
            # audio_file_path lives only inside the settings JSONB; the
            # video_tasks table has no top-level column for it.
            audio_file_path = task_settings.get("audio_file_path")

            if not final_video_url or not task_data.get("subtitles"):
                msg = ("missing final_video_url" if not final_video_url
                       else "subtitles config not set on task")
                print(f"[subtitles] cannot burn: {msg}")
                supabase.table("video_tasks").update({
                    "subtitles_status": "failed",
                    "error_message": f"Subtitle burn skipped: {msg}",
                    "updated_at": "now()",
                }).eq("id", video_task_id).execute()
                return add_cors_headers(request, {"status": "skipped", "reason": msg})

            # ── Per-chunk burn ────────────────────────────────────────
            if chunk_index is not None:
                burn_temp_dir = tempfile.mkdtemp(prefix="subs_chunk_")
                try:
                    state = _read_burn_state(supabase, video_task_id)
                    if not state or not isinstance(state.get("plan"), list):
                        raise RuntimeError("missing burn state for chunk")
                    plan = state["plan"]
                    idx = int(chunk_index)
                    if idx < 0 or idx >= len(plan):
                        raise RuntimeError(f"chunk_index {idx} out of range")
                    chunk = plan[idx]
                    cfg = get_subtitle_config(supabase, video_task_id)
                    if not cfg:
                        raise RuntimeError("subtitles config disappeared")
                    words = load_word_timestamps_from_task(
                        supabase, video_task_id)
                    if not words:
                        raise RuntimeError("no narration_word_timestamps")

                    chunks_path = state['path'].rstrip('/')
                    raw_storage_path = f"{chunks_path}/raw_{idx}.mp4"
                    raw_local = os.path.join(burn_temp_dir, f"raw_{idx}.mp4")
                    used_pre_split = _download_chunk_from_storage(
                        supabase_url, supabase_key,
                        raw_storage_path, raw_local)

                    if used_pre_split:
                        # Fast path: only the slice (~400 MB) was downloaded.
                        seg_path = burn_subtitle_chunk_from_raw(
                            raw_local, words, chunk, cfg, burn_temp_dir)
                        # Free the raw input from /tmp ASAP.
                        try:
                            os.remove(raw_local)
                        except OSError:
                            pass
                    else:
                        # Fallback: pre-split missing → download full final
                        # and cut locally (legacy behaviour, still correct).
                        print(
                            f"[subtitles] raw chunk {idx} missing in storage; "
                            "falling back to full-video download + local cut")
                        local_video = os.path.join(burn_temp_dir, "source.mp4")
                        if not _download_final_video_for_burn(
                                supabase_url, supabase_key, final_video_url, local_video):
                            raise RuntimeError("download_failed")
                        seg_path = burn_subtitle_chunk(
                            local_video, words, chunk, cfg, burn_temp_dir)
                        try:
                            os.remove(local_video)
                        except OSError:
                            pass

                    if not seg_path:
                        raise RuntimeError("burn_subtitle_chunk failed")

                    storage_path = f"{chunks_path}/seg_{idx}.mp4"
                    if not _upload_chunk_to_storage(
                            supabase, seg_path, storage_path):
                        raise RuntimeError("chunk upload failed")

                    # Free /tmp ASAP
                    try:
                        os.remove(seg_path)
                    except OSError:
                        pass

                    new_completed = int(state.get("completed", 0)) + 1
                    state["completed"] = new_completed
                    _write_burn_state(supabase, video_task_id, state)
                    try:
                        # 95 → 99 % progress band reserved for chunk burns;
                        # 100 % is set in the concat branch.
                        pct = 95 + \
                            int(round(4 * new_completed / max(1, len(plan))))
                        supabase.table("video_tasks").update({
                            "video_creation_progress": pct,
                            "overall_progress": pct,
                            "updated_at": "now()",
                        }).eq("id", video_task_id).execute()
                    except Exception:
                        pass

                    if new_completed < len(plan):
                        trigger_subtitle_burn_async(
                            supabase_url, supabase_key, video_task_id,
                            user_id, group_id, tab=tab,
                            chunk_index=idx + 1)
                        return add_cors_headers(request, {
                            "status": "chunk_done",
                            "chunk_index": idx,
                            "completed": new_completed,
                            "total": len(plan),
                        })
                    # All chunks burned → dispatch concat
                    trigger_subtitle_burn_async(
                        supabase_url, supabase_key, video_task_id,
                        user_id, group_id, tab=tab, concat_chunks=True)
                    return add_cors_headers(request, {
                        "status": "chunks_complete",
                        "message": "All chunks burned; concat dispatched",
                        "total": len(plan),
                    })
                except Exception as chunk_err:
                    print(f"[subtitles] chunk burn error: {chunk_err}")
                    # Per-chunk retry: bounce ONCE via burn_subtitles_retry.
                    if not burn_retry:
                        trigger_subtitle_burn_async(
                            supabase_url, supabase_key, video_task_id,
                            user_id, group_id, tab=tab, retry=True,
                            chunk_index=chunk_index)
                        return add_cors_headers(request, {
                            "status": "retry_triggered",
                            "chunk_index": chunk_index,
                        })
                    # Final failure: drop chunked state, mark failed.
                    _clear_burn_state(supabase, video_task_id)
                    _mark_subtitles_completed(
                        supabase, video_task_id, user_id, group_id, tab,
                        final_video_url, "", task_settings,
                        subtitles_status='failed',
                        audio_path_for_cleanup=audio_file_path,
                        supabase_url=supabase_url, supabase_key=supabase_key,
                    )
                    return add_cors_headers(request, {
                        "status": "failed",
                        "message": f"Chunk {chunk_index} failed after retry",
                    }, 200)
                finally:
                    try:
                        shutil.rmtree(burn_temp_dir, ignore_errors=True)
                    except Exception:
                        pass

            # ── Concat already-burned chunks ──────────────────────────
            if is_concat:
                concat_temp_dir = tempfile.mkdtemp(prefix="subs_concat_")
                concat_started_at = time.time()
                try:
                    state = _read_burn_state(supabase, video_task_id)
                    if not state or not isinstance(state.get("plan"), list):
                        raise RuntimeError("missing burn state for concat")
                    plan = state["plan"]
                    chunks_path = state["path"]
                    if chunks_path.endswith('/'):
                        chunks_path = chunks_path[:-1]

                    # Download all seg_<i>.mp4
                    local_segs = []
                    storage_paths = []
                    for entry in plan:
                        i = int(entry["i"])
                        spath = f"{chunks_path}/seg_{i}.mp4"
                        lpath = os.path.join(concat_temp_dir, f"seg_{i}.mp4")
                        if not _download_chunk_from_storage(
                                supabase_url, supabase_key, spath, lpath):
                            raise RuntimeError(f"download chunk {i} failed")
                        local_segs.append(lpath)
                        storage_paths.append(spath)
                    # Pre-split raws are also staged here when len(plan) > 1.
                    # Schedule them for cleanup whether they exist or not —
                    # the bulk delete tolerates missing keys.
                    if state.get("pre_split"):
                        for entry in plan:
                            storage_paths.append(
                                f"{chunks_path}/raw_{int(entry['i'])}.mp4")

                    final_local = os.path.join(concat_temp_dir, "final.mp4")
                    if not concat_burned_chunks(local_segs, final_local):
                        raise RuntimeError("concat failed")

                    # Free /tmp before the upload
                    for p in local_segs:
                        try:
                            os.remove(p)
                        except OSError:
                            pass

                    # Upload (overwrite) the burned final video
                    obj_path_in_bucket = final_video_url
                    with open(final_local, 'rb') as f:
                        try:
                            supabase.storage.from_("videos").upload(
                                obj_path_in_bucket, f,
                                {"content-type": "video/mp4",
                                 "x-upsert": "true"},
                            )
                        except Exception:
                            try:
                                supabase.storage.from_("videos").remove(
                                    [obj_path_in_bucket])
                            except Exception:
                                pass
                            with open(final_local, 'rb') as f2:
                                supabase.storage.from_("videos").upload(
                                    obj_path_in_bucket, f2,
                                    {"content-type": "video/mp4"},
                                )
                    print(
                        f"[subtitles] re-uploaded burned video to {final_video_url}")

                    # Promote pending tokens + this concat run's runtime
                    # into subtitle_tokens (single trigger fire). The
                    # decorator skipped its own charge (subtitle_concat_chunks
                    # is True). We track elapsed time from the start of the
                    # concat handler; the decorator logs the precise total
                    # runtime separately to gcf_runtime_log.
                    concat_runtime = max(0.0, time.time() - concat_started_at)
                    finalize_subtitle_tokens(
                        supabase,
                        user_id=user_id,
                        video_task_id=video_task_id,
                        gcf_name=f"create-final-video{('-high-memory' if is_high_memory else '')}",
                        runtime_seconds=concat_runtime,
                    )

                    _delete_chunks_from_storage(supabase, storage_paths)
                    _clear_burn_state(supabase, video_task_id)

                    _mark_subtitles_completed(
                        supabase, video_task_id, user_id, group_id, tab,
                        final_video_url, final_local, task_settings,
                        subtitles_status='completed',
                        audio_path_for_cleanup=audio_file_path,
                        supabase_url=supabase_url, supabase_key=supabase_key,
                    )
                    return add_cors_headers(request, {
                        "status": "success",
                        "message": "Chunks concatenated; subtitles complete",
                        "video_path": final_video_url,
                        "chunks": len(plan),
                    })
                except Exception as concat_err:
                    print(f"[subtitles] concat error: {concat_err}")
                    if not burn_retry:
                        trigger_subtitle_burn_async(
                            supabase_url, supabase_key, video_task_id,
                            user_id, group_id, tab=tab, retry=True,
                            concat_chunks=True)
                        return add_cors_headers(request, {
                            "status": "retry_triggered",
                            "message": "Concat failed, retry initiated",
                        })
                    _clear_burn_state(supabase, video_task_id)
                    _mark_subtitles_completed(
                        supabase, video_task_id, user_id, group_id, tab,
                        final_video_url, "", task_settings,
                        subtitles_status='failed',
                        audio_path_for_cleanup=audio_file_path,
                        supabase_url=supabase_url, supabase_key=supabase_key,
                    )
                    return add_cors_headers(request, {
                        "status": "failed",
                        "message": "Subtitle concat failed after retry",
                    }, 200)
                finally:
                    try:
                        shutil.rmtree(concat_temp_dir, ignore_errors=True)
                    except Exception:
                        pass

            # ── Initial dispatch: probe duration → plan chunks ────────
            # Short videos use the legacy single-shot burn path (still
            # safely under the 60-min ceiling). Long videos plan chunks
            # and dispatch chunk 0; the rest fan out from there.
            burn_temp_dir = tempfile.mkdtemp(prefix="subs_burn_")
            local_video = os.path.join(burn_temp_dir, "final.mp4")
            try:
                if not _download_final_video_for_burn(
                        supabase_url, supabase_key, final_video_url, local_video):
                    raise RuntimeError("download_failed")

                video_dur = _probe_video_duration_secs(local_video)
                if video_dur > _SUBS_CHUNK_THRESHOLD_SEC:
                    words = load_word_timestamps_from_task(
                        supabase, video_task_id)
                    if not words:
                        # No timestamps → cannot plan natural chunks; fall
                        # back to the legacy single-shot path. It will
                        # likely time out for very long videos but at least
                        # tries.
                        print("[subtitles] long video but no word timestamps; "
                              "falling back to single-shot burn")
                    else:
                        plan = plan_subtitle_chunks(
                            words, video_dur,
                            target_chunk_sec=_SUBS_TARGET_CHUNK_SEC,
                            min_chunk_sec=_SUBS_MIN_CHUNK_SEC,
                        )
                        if len(plan) > 1:
                            chunks_path = _subs_chunks_dir(
                                user_id, group_id, video_task_id)

                            # Pre-split: copy-cut each chunk locally and
                            # upload as raw_<i>.mp4. Each per-chunk worker
                            # then downloads only its own ~slice/total share
                            # of bytes instead of the full final video.
                            # Skip cleanly if any cut/upload fails — the
                            # per-chunk handler falls back to the legacy
                            # full-download path automatically.
                            uploaded_raw = 0
                            split_started = time.time()
                            for entry in plan:
                                i = int(entry["i"])
                                cstart = float(entry["start"])
                                cend = float(entry["end"])
                                raw_local = os.path.join(
                                    burn_temp_dir, f"raw_{i}.mp4")
                                if not _subs_copy_cut_segment(
                                        local_video, cstart, cend, raw_local):
                                    print(
                                        f"[subtitles] pre-split cut {i} failed; "
                                        "skipping pre-split (workers will "
                                        "fall back to full-video download)")
                                    uploaded_raw = 0
                                    break
                                raw_storage = f"{chunks_path}/raw_{i}.mp4"
                                ok_up = _upload_chunk_to_storage(
                                    supabase, raw_local, raw_storage)
                                # Free /tmp immediately regardless of upload
                                # outcome — keeps peak well under 16 GB.
                                try:
                                    os.remove(raw_local)
                                except OSError:
                                    pass
                                if not ok_up:
                                    print(
                                        f"[subtitles] pre-split upload {i} failed; "
                                        "abandoning pre-split")
                                    uploaded_raw = 0
                                    break
                                uploaded_raw += 1
                            split_seconds = time.time() - split_started
                            print(
                                f"[subtitles] pre-split: uploaded "
                                f"{uploaded_raw}/{len(plan)} raw chunks in "
                                f"{split_seconds:.1f}s")

                            state = {
                                "total": len(plan),
                                "completed": 0,
                                "path": chunks_path,
                                "plan": plan,
                                "pre_split": uploaded_raw == len(plan),
                            }
                            _write_burn_state(supabase, video_task_id, state)
                            # Reset accumulator in case of a previous failed run.
                            try:
                                supabase.table("video_tasks").update({
                                    "subtitle_tokens_pending": 0,
                                    "video_creation_progress": 95,
                                    "overall_progress": 95,
                                    "updated_at": "now()",
                                }).eq("id", video_task_id).execute()
                            except Exception:
                                pass
                            trigger_subtitle_burn_async(
                                supabase_url, supabase_key, video_task_id,
                                user_id, group_id, tab=tab, chunk_index=0)
                            print(
                                f"[subtitles] planned {len(plan)} chunks "
                                f"for {video_dur:.0f}s video; dispatched chunk 0")
                            return add_cors_headers(request, {
                                "status": "chunked_dispatched",
                                "total_chunks": len(plan),
                                "video_duration_sec": round(video_dur, 1),
                                "pre_split": uploaded_raw == len(plan),
                            })

                # Single-shot path (short videos OR long videos w/o words)
                burn_started = time.time()
                burned = False
                try:
                    burned = bool(maybe_burn_subtitles(
                        supabase, video_task_id, local_video, burn_temp_dir))
                except Exception as _be:
                    print(f"[subtitles] burn raised: {_be}")
                    burned = False
                burn_seconds = time.time() - burn_started
                print(
                    f"[subtitles] burn finished in {burn_seconds:.1f}s (success={burned})")

                if not burned:
                    raise RuntimeError("burn_failed")

                # Re-upload to the same storage path (overwrite/upsert).
                # final_video_url is the *object path within the `videos`
                # bucket* (it just happens to start with the literal segment
                # "videos/"), NOT a "bucket/path" string. Use it as-is.
                bucket_name = "videos"
                obj_path_in_bucket = final_video_url
                with open(local_video, 'rb') as f:
                    try:
                        supabase.storage.from_(bucket_name).upload(
                            obj_path_in_bucket, f,
                            {"content-type": "video/mp4",
                             "x-upsert": "true"},
                        )
                    except Exception:
                        # supabase-py fallback: remove + upload
                        try:
                            supabase.storage.from_(bucket_name).remove(
                                [obj_path_in_bucket])
                        except Exception:
                            pass
                        with open(local_video, 'rb') as f2:
                            supabase.storage.from_(bucket_name).upload(
                                obj_path_in_bucket, f2,
                                {"content-type": "video/mp4"},
                            )
                print(
                    f"[subtitles] re-uploaded burned video to {final_video_url}")

                # Token charging is handled by the @billed decorator on
                # this entry function. When burn_subtitles_only=True is
                # in the request body, _billing routes the runtime charge
                # to video_tasks.subtitle_tokens (clean 0 → X delta on a
                # dedicated column). The DB trigger
                # video_tasks_tokens_update mirrors the delta into
                # user_plans.tokens_used — do NOT bump user_plans here.

                # Mark fully complete (incl. story_documents + cleanup)
                _mark_subtitles_completed(
                    supabase, video_task_id, user_id, group_id, tab,
                    final_video_url, local_video, task_settings,
                    subtitles_status='completed',
                    audio_path_for_cleanup=audio_file_path,
                    supabase_url=supabase_url, supabase_key=supabase_key,
                )
                return add_cors_headers(request, {
                    "status": "success",
                    "message": "Subtitles burned and final video updated",
                    "video_path": final_video_url,
                    "burn_seconds": round(burn_seconds, 2),
                })

            except Exception as burn_err:
                print(f"[subtitles] burn pipeline error: {burn_err}")
                if not burn_retry:
                    if trigger_subtitle_burn_async(
                            supabase_url, supabase_key, video_task_id,
                            user_id, group_id, tab=tab, retry=True):
                        return add_cors_headers(request, {
                            "status": "retry_triggered",
                            "message": "Subtitle burn failed, retry initiated",
                        })
                # Final failure: keep video as-is, mark subtitles failed,
                # and finish the task so the user isn't stuck waiting.
                _mark_subtitles_completed(
                    supabase, video_task_id, user_id, group_id, tab,
                    final_video_url, local_video, task_settings,
                    subtitles_status='failed',
                    audio_path_for_cleanup=audio_file_path,
                    supabase_url=supabase_url, supabase_key=supabase_key,
                )
                return add_cors_headers(request, {
                    "status": "failed",
                    "message": "Subtitle burn failed after retry; video kept without subtitles",
                }, 200)
            finally:
                try:
                    shutil.rmtree(burn_temp_dir, ignore_errors=True)
                except Exception:
                    pass

        # NEW: Handle batch processing continuation
        if continue_batch_processing:
            print(
                f"Continuing batch processing from batch {continue_from_batch}")

            # Fetch task to detect TTV/ITV mode and get clip_assembly_data
            task_result = supabase.table("video_tasks").select(
                "*").eq("id", video_task_id).single().execute()
            if not task_result.data:
                return add_cors_headers(request, {"error": "Video task not found for continuation"}, 404)

            cont_task = task_result.data
            cont_settings = cont_task.get("settings", {})

            # For batch processing continuation, reconstruct video paths from the stored progress
            if not individual_videos_paths:
                # Standard path reconstruction from progress data or video_durations
                progress = cont_task.get("transition_batch_progress", {})
                total_videos = progress.get("total_videos", 0)
                individual_videos_paths = [
                    f"videos/{user_id}/{group_id}/individual_videos/video_{i}.mp4" for i in range(1, total_videos + 1)]

                if not individual_videos_paths:
                    return add_cors_headers(request, {"error": "No transition batch progress found for continuation"}, 400)

            # Sort paths naturally
            individual_videos_paths_sorted = sorted(
                individual_videos_paths, key=lambda x: natural_sort_key(os.path.basename(x)))

            # Get visual_type for batch size determination
            cont_visual_type = cont_task.get('visual_type') or (cont_settings.get(
                'visual_type') if isinstance(cont_settings, dict) else 'image') or 'image'

            with tempfile.TemporaryDirectory() as temp_dir:
                result = process_transition_batches_internal(
                    supabase, video_task_id, user_id, group_id,
                    individual_videos_paths_sorted, transition_type,
                    transition_duration, temp_dir, continue_from_batch, tab, visual_type=cont_visual_type)

                if result["status"] == "retry_triggered":
                    return add_cors_headers(request, {
                        "status": "retry_triggered",
                        "message": result["message"],
                        "failed_batch": result["failed_batch"]
                    })
                elif result["status"] == "continuing":
                    return add_cors_headers(request, {
                        "status": "success",
                        "message": f"Processed batches {result['processed_batches']}, continuing with batch {result['next_batch']}",
                        "processed_batches": result["processed_batches"],
                        "next_batch": result["next_batch"],
                        "total_batches": result["total_batches"]
                    })
                elif result["status"] == "completed":
                    # All batches done, trigger final assembly
                    try:
                        requests.post(
                            f"{supabase_url}/functions/v1/process-transition-batches",
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                                "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                            },
                            json={
                                "video_task_id": video_task_id,
                                "user_id": user_id,
                                "group_id": group_id,
                                "final_assembly": True,
                                "tab": tab
                            }
                        )
                        print("Triggered final assembly")
                    except Exception as e:
                        print(
                            f"Fire-and-forget trigger for final assembly: {str(e)}")

                    return add_cors_headers(request, {
                        "status": "success",
                        "message": "All transition batches completed, final assembly triggered",
                        "processed_batches": result["processed_batches"],
                        "total_batches": result["total_batches"]
                    })

        # NEW: Handle final assembly from transition batches
        if final_assembly_flag:
            print("Processing final assembly from transition batches")

            # Get video task details for final assembly
            task_result = supabase.table("video_tasks").select(
                "*").eq("id", video_task_id).single().execute()
            if not task_result.data:
                return add_cors_headers(request, {"error": "Video task not found"}, 404)

            task = task_result.data
            settings = parse_settings_json(task.get("settings", "{}"))

            # Update status to running
            supabase.table("video_tasks").update({
                "video_creation_status": "running",
                "overall_status": "running",
                "updated_at": "now()"
            }).eq("id", video_task_id).execute()

            # Get audio path, background music, and model version
            audio_path = settings.get(
                "audio_file_path") or settings.get("audio_folder_path")
            bg_music_url = task.get("bg_music") or settings.get("bg_music")
            bg_music_volume = task.get(
                "bg_music_volume") or settings.get("bg_music_volume", 0.25)
            model_version = settings.get("model_version", "v6")

            if not audio_path:
                return add_cors_headers(request, {"error": "Audio path not found in task settings"}, 400)

            with tempfile.TemporaryDirectory() as temp_dir:
                # Download and merge audio files
                audio_local_path, detected_extension = download_and_merge_audio_files(
                    supabase_url, supabase_key, audio_path, temp_dir)

                if not audio_local_path:
                    return add_cors_headers(request, {"error": "Failed to download or merge audio files"}, 500)

                # Download background music if provided
                bg_music_local_path = None
                if bg_music_url:
                    bg_music_local_path = download_background_music(
                        bg_music_url, temp_dir)

                # Assemble final video from transition batches
                concatenated_video_path = final_assembly_from_transition_batches(
                    supabase, video_task_id, user_id, group_id, temp_dir)

                # ── TTV/ITV speech audio download for transition-batch assembly ──
                visual_type = task.get('visual_type') or settings.get(
                    'visual_type') or 'image'
                clip_assembly_data = task.get('clip_assembly_data')
                use_speech_assembly = False
                actual_durations_for_assembly = None
                clip_audio_files_for_assembly = None

                if clip_assembly_data and visual_type in ('ttv', 'itv'):
                    has_speech_list = clip_assembly_data.get('has_speech', [])
                    if any(has_speech_list):
                        print(
                            f"\n=== TTV/ITV final_assembly: downloading speech audio files ===")
                        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
                        # Reconstruct total video count from transition_batch_progress
                        progress = task.get('transition_batch_progress', {})
                        total_videos = progress.get('total_videos', 0)
                        clip_audios = []
                        actual_durs = []

                        # Use target_durations from clip_assembly_data for timing
                        target_durs = clip_assembly_data.get(
                            'target_durations', [])

                        for idx in range(total_videos):
                            clip_num = idx + 1
                            dur = target_durs[idx] if idx < len(
                                target_durs) else 5.0
                            actual_durs.append(dur)

                            # Download audio for ALL clips (matching SSAIVidGen.py)
                            audio_dl_path = f"videos/{user_id}/{group_id}/individual_videos/audio_{clip_num}.aac"
                            local_audio = os.path.join(
                                temp_dir, f"speech_{clip_num:03d}.aac")
                            audio_dl_url = f"{supabase_url}/storage/v1/object/videos/{audio_dl_path}"
                            if download_file(audio_dl_url, local_audio, headers):
                                clip_audios.append((idx, local_audio, dur))
                                is_speech = has_speech_list[idx] if idx < len(
                                    has_speech_list) else False
                                tag = "🗣️" if is_speech else "🔇"
                                print(
                                    f"  {tag} Downloaded audio for clip {clip_num}")
                            else:
                                print(
                                    f"  ⚠️ Audio not found for clip {clip_num}")

                        if clip_audios:
                            use_speech_assembly = True
                            actual_durations_for_assembly = actual_durs
                            clip_audio_files_for_assembly = clip_audios
                            print(
                                f"  Speech audio ready: {len(clip_audios)} tracks")
                        else:
                            print(
                                "  No speech audio files found, using standard audio mix")

                # Combine video with audio and optional background music
                final_video_path = os.path.join(temp_dir, "final_video.mp4")
                ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

                # ── Speech-aware audio assembly (TTV/ITV with audio_clip) ──
                speech_audio_done = False
                if use_speech_assembly and actual_durations_for_assembly:
                    speech_audio_done = assemble_speech_audio(
                        concatenated_video_path, audio_local_path,
                        clip_audio_files_for_assembly, clip_assembly_data,
                        actual_durations_for_assembly,
                        True, settings.get('transition_duration', 0.5),
                        bg_music_local_path, bg_music_volume,
                        final_video_path, ffmpeg_path, temp_dir
                    )
                    if not speech_audio_done:
                        print("Speech audio assembly failed — "
                              "falling back to standard audio combination")

                try:
                    if speech_audio_done:
                        pass  # Audio already combined by speech assembly
                    elif bg_music_local_path:
                        # Single-pass mux: video + narration + bg-music in ONE
                        # ffmpeg invocation. Avoids writing a ~5GB intermediate
                        # `video_with_narration.mp4` to /tmp (which is RAM-backed
                        # in GCF and overflows for multi-hour outputs).
                        video_dur = get_video_duration(concatenated_video_path)
                        print(f"Video duration for bg music mix: {video_dur}s")

                        subprocess.run([
                            ffmpeg_path, '-y',
                            '-i', concatenated_video_path,
                            '-i', audio_local_path,
                            '-i', bg_music_local_path,
                            '-filter_complex',
                            f'[1:a]volume=1.0,apad=whole_dur={video_dur}[narr];'
                            f'[2:a]volume={bg_music_volume},aloop=loop=-1:size=2e+09,atrim=end={video_dur}[music];'
                            f'[narr][music]amix=inputs=2:duration=shortest:dropout_transition=3:normalize=0[aout]',
                            '-map', '0:v:0',
                            '-map', '[aout]',
                            '-c:v', 'copy',
                            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                            '-avoid_negative_ts', 'make_zero',
                            '-fflags', '+genpts',
                            '-movflags', '+faststart',
                            final_video_path
                        ], check=True, capture_output=True)
                        print(
                            "Video created with narration and background music (single-pass)")
                    else:
                        # No background music - simple audio mapping (matching SSAIVidGen.py)
                        # Video is padded 5s beyond audio so it always wins; no need for
                        # silence padding or adelay — just map the audio directly.
                        subprocess.run([
                            ffmpeg_path, '-y', '-i', concatenated_video_path, '-i', audio_local_path,
                            '-c:v', 'copy',
                            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                            '-map', '0:v:0', '-map', '1:a:0',
                            '-avoid_negative_ts', 'make_zero',
                            '-fflags', '+genpts',
                            '-movflags', '+faststart',
                            final_video_path
                        ], check=True, capture_output=True)
                        print(
                            "Video created with narration audio (SSAIVidGen.py method)")

                except subprocess.CalledProcessError as e:
                    return add_cors_headers(request, {"error": f"Audio/video combination failed: {e.stderr.decode()}"}, 500)

                # ── Subtitles are now burned ASYNCHRONOUSLY in a separate
                # create-final-video invocation triggered after upload. The
                # synchronous burn was removed so users aren't blocked by the
                # multi-minute re-encode. NULL subtitles config = no-op.

                # Upload final video
                timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
                story_title = settings.get("story_title", "video")
                sanitized_title = sanitize_filename(story_title)
                final_video_name = f"{sanitized_title}_{timestamp}.mp4"
                final_video_upload_path = f"videos/{user_id}/{group_id}/{final_video_name}"

                video_uploaded, uploaded_file_size = upload_file_to_supabase_with_verification(
                    supabase, final_video_path, final_video_upload_path, 'videos', 'video/mp4')

                if not video_uploaded:
                    # Trigger retry via edge function
                    if trigger_retry_via_edge_function(supabase_url, supabase_key, video_task_id, user_id, group_id, tab):
                        return add_cors_headers(request, {"status": "retry_triggered", "message": "Upload failed, retry initiated"})
                    else:
                        return add_cors_headers(request, {"error": "Failed to upload final video"}, 500)

                # Update completion status
                file_size = uploaded_file_size if uploaded_file_size > 0 else os.path.getsize(
                    final_video_path)

                # ── Async subtitle burn dispatch (transition path) ─────────
                # If subtitles are configured, defer "completed_final" status
                # until the second invocation finishes the burn. The video
                # URL is recorded so the burn step can download + re-upload.
                _subs_cfg = None
                try:
                    _subs_row = supabase.table("video_tasks").select(
                        "subtitles").eq("id", video_task_id).single().execute()
                    _subs_cfg = (_subs_row.data or {}).get("subtitles")
                except Exception as _e:
                    print(
                        f"[subtitles] could not check subtitles config: {_e}")
                if _subs_cfg:
                    print(
                        "[subtitles] uploaded un-subtitled video; dispatching async burn")
                    supabase.table("video_tasks").update({
                        "video_creation_status": "burning_subtitles",
                        "overall_status": "burning_subtitles",
                        "subtitles_status": "pending",
                        "final_video_url": final_video_upload_path,
                        "video_creation_progress": 95,
                        "overall_progress": 95,
                        "updated_at": "now()",
                    }).eq("id", video_task_id).execute()
                    trigger_subtitle_burn_async(
                        supabase_url, supabase_key, video_task_id,
                        user_id, group_id, tab=tab, retry=False)
                    return add_cors_headers(request, {
                        "status": "subtitles_processing",
                        "message": "Final video uploaded; burning subtitles asynchronously",
                        "video_path": final_video_upload_path,
                        "file_size": file_size,
                    })

                update_data = {
                    "video_creation_status": "completed_final",
                    "overall_status": "completed_final",
                    "individual_video_status": "completed_final",
                    "story_status": "completed_final",
                    "image_prompt_status": "completed_final",
                    "image_generation_status": "completed_final",
                    "audio_status": "completed_final",
                    "overall_progress": 100,
                    "story_progress": 100,
                    "image_prompt_progress": 100,
                    "image_generation_progress": 100,
                    "audio_progress": 100,
                    "video_creation_progress": 100,
                    "individual_video_progress": 100,
                    "final_video_url": final_video_upload_path,
                    "completed_at": "now()",
                    "updated_at": "now()"
                }

                supabase.table("video_tasks").update(
                    update_data).eq("id", video_task_id).execute()

                # Update all batch tasks to completed_final
                supabase.table("video_tasks").update({
                    "video_creation_status": "completed_final",
                    "overall_status": "completed_final",
                    "individual_video_status": "completed_final",
                    "story_status": "completed_final",
                    "image_prompt_status": "completed_final",
                    "image_generation_status": "completed_final",
                    "audio_status": "completed_final",
                    "overall_progress": 100,
                    "story_progress": 100,
                    "image_prompt_progress": 100,
                    "image_generation_progress": 100,
                    "audio_progress": 100,
                    "video_creation_progress": 100,
                    "individual_video_progress": 100,
                    "updated_at": "now()"
                }).eq("user_id", user_id).eq("group_id", group_id).execute()

                # Insert metadata BEFORE cleanup - prevents loss if function times out during cleanup
                try:
                    next_variant = get_next_video_variant(
                        supabase, user_id, group_id)
                    supabase.table("story_documents").insert({
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "group_id": group_id,
                        "created_at": "now()",
                        "updated_at": "now()",
                        "file_path": final_video_upload_path,
                        "title": settings.get("story_title", "Final Video"),
                        "description": "Final Video",
                        "file_size": file_size,
                        "variant": next_variant,
                        "version": 11,
                        "is_corrected": False,
                        "is_prompted": False,
                        "word_count": 0,
                        "tab": tab
                    }).execute()
                    print(
                        "Metadata inserted to story_documents with 'Final Video' description")
                except Exception as metadata_error:
                    print(f"Failed to insert metadata: {str(metadata_error)}")

                # Cleanup AFTER metadata insert so a timeout here doesn't lose the record
                cleanup_storage_after_completion(
                    supabase_url, supabase_key, user_id, group_id, audio_path)

                # Delete intermediate task rows now that video is complete
                delete_task_rows(supabase, user_id, group_id)

                return add_cors_headers(request, {
                    "status": "success",
                    "message": "Final video created successfully from transition batches",
                    "video_path": final_video_upload_path,
                    "file_size": file_size,
                    "transition_batches_used": True
                })

        # ORIGINAL LOGIC CONTINUES HERE...
        # Get video task details
        try:
            task_result = supabase.table("video_tasks").select(
                "*").eq("id", video_task_id).single().execute()

            print(f"DEBUG: task_result type: {type(task_result)}")
            print(f"DEBUG: task_result.data type: {type(task_result.data)}")
            print(f"DEBUG: task_result.data: {task_result.data}")

            if not task_result.data:
                return add_cors_headers(request, {"error": "Video task not found"}, 404)

            # Handle different response formats
            if isinstance(task_result.data, list) and len(task_result.data) > 0:
                task = task_result.data[0]
            elif isinstance(task_result.data, dict):
                task = task_result.data
            else:
                print(
                    f"ERROR: Unexpected task_result.data format: {type(task_result.data)}")
                return add_cors_headers(request, {"error": f"Unexpected data format: {type(task_result.data)}"}, 500)

            print(f"DEBUG: Final task object: {task}")
            settings = parse_settings_json(task.get("settings", "{}"))
            print(f"DEBUG: Parsed settings: {settings}")

        except Exception as e:
            print(f"ERROR in task retrieval: {str(e)}")
            return add_cors_headers(request, {"error": f"Task retrieval error: {str(e)}"}, 500)

        # ── Motion Graphics (MG) short-circuit ─────────────────────────
        # MG clips are pre-rendered by Remotion-Lambda and recorded on
        # clip_assembly_data.mg_clips with full S3 URLs and durations.
        # Skip Ken Burns / image-to-video / transition pipelines entirely:
        # download clips, concat in batch_number order, mux with narration
        # (+ optional bg music + optional subtitles), upload, complete.
        if (task.get("visual_type") or settings.get("visual_type")) == "mg":
            print("=== MG branch: assembling Motion Graphics final video ===")
            clip_assembly_data = task.get("clip_assembly_data") or {}
            if isinstance(clip_assembly_data, str):
                try:
                    import json as _json_mg
                    clip_assembly_data = _json_mg.loads(clip_assembly_data)
                except Exception:
                    clip_assembly_data = {}
            mg_clips = sorted(
                clip_assembly_data.get("mg_clips") or [],
                key=lambda c: (c.get("batch_number") or 0)
            )
            if not mg_clips:
                return add_cors_headers(request, {
                    "error": "MG branch: no mg_clips found in clip_assembly_data"
                }, 400)

            mg_audio_path = settings.get("audio_file_path") or settings.get("audio_folder_path")
            mg_bg_music_url = task.get("bg_music") or settings.get("bg_music")
            mg_bg_music_volume = task.get("bg_music_volume") or settings.get("bg_music_volume", 0.25)
            if not mg_audio_path:
                return add_cors_headers(request, {"error": "Audio path not found in task settings"}, 400)

            mg_tokens_to_add = calculate_transition_tokens(len(mg_clips), False, visual_type="mg")
            mg_safe_tokens = check_user_token_balance(supabase, user_id, mg_tokens_to_add)
            mg_tokens_used = mg_safe_tokens
            mg_can_add_tokens = mg_safe_tokens > 0

            supabase.table("video_tasks").update({
                "video_creation_status": "running",
                "overall_status": "running",
                "updated_at": "now()"
            }).eq("id", video_task_id).execute()

            with tempfile.TemporaryDirectory() as temp_dir:
                local_clip_paths = []
                for idx, clip in enumerate(mg_clips, start=1):
                    clip_url = clip.get("video_url")
                    if not clip_url:
                        return add_cors_headers(request, {
                            "error": f"MG clip {idx} missing video_url"
                        }, 500)
                    local_clip_path = os.path.join(temp_dir, f"mg_clip_{idx:04d}.mp4")
                    if not download_file(clip_url, local_clip_path, {}):
                        return add_cors_headers(request, {
                            "error": f"Failed to download MG clip {idx} from {clip_url[:120]}"
                        }, 500)
                    local_clip_paths.append(local_clip_path)
                print(f"MG: downloaded {len(local_clip_paths)} clips")

                print(f"MG: downloading narration audio from {mg_audio_path}")
                mg_audio_local_path, mg_detected_ext = download_and_merge_audio_files(
                    supabase_url, supabase_key, mg_audio_path, temp_dir)
                if not mg_audio_local_path:
                    return add_cors_headers(request, {"error": "Failed to download or merge audio files"}, 500)

                mg_bg_music_local_path = None
                if mg_bg_music_url:
                    mg_bg_music_local_path = download_background_music(mg_bg_music_url, temp_dir)
                    if not mg_bg_music_local_path:
                        print("MG: bg music download failed; proceeding without it")

                mg_concat_path = os.path.join(temp_dir, "mg_concatenated.mp4")
                if not concatenate_videos_simple(local_clip_paths, mg_concat_path):
                    return add_cors_headers(request, {"error": "MG clip concatenation failed"}, 500)

                mg_final_video_path = os.path.join(temp_dir, "final_video.mp4")
                mg_ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")
                try:
                    if mg_bg_music_local_path:
                        mg_video_dur = get_video_duration(mg_concat_path)
                        subprocess.run([
                            mg_ffmpeg_path, "-y",
                            "-i", mg_concat_path,
                            "-i", mg_audio_local_path,
                            "-i", mg_bg_music_local_path,
                            "-filter_complex",
                            f"[1:a]volume=1.0,apad=whole_dur={mg_video_dur}[narr];"
                            f"[2:a]volume={mg_bg_music_volume},aloop=loop=-1:size=2e+09,atrim=end={mg_video_dur}[music];"
                            f"[narr][music]amix=inputs=2:duration=shortest:dropout_transition=3:normalize=0[aout]",
                            "-map", "0:v:0",
                            "-map", "[aout]",
                            "-c:v", "copy",
                            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                            "-avoid_negative_ts", "make_zero",
                            "-fflags", "+genpts",
                            "-movflags", "+faststart",
                            mg_final_video_path
                        ], check=True, capture_output=True)
                    else:
                        subprocess.run([
                            mg_ffmpeg_path, "-y",
                            "-i", mg_concat_path,
                            "-i", mg_audio_local_path,
                            "-c:v", "copy",
                            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
                            "-map", "0:v:0", "-map", "1:a:0",
                            "-avoid_negative_ts", "make_zero",
                            "-fflags", "+genpts",
                            "-movflags", "+faststart",
                            mg_final_video_path
                        ], check=True, capture_output=True)
                except subprocess.CalledProcessError as mg_mux_err:
                    mg_err_msg = mg_mux_err.stderr.decode() if mg_mux_err.stderr else str(mg_mux_err)
                    print(f"MG mux error: {mg_err_msg}")
                    return add_cors_headers(request, {"error": f"MG audio/video combination failed: {mg_err_msg}"}, 500)

                mg_timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
                mg_story_title = settings.get("story_title", "video")
                mg_sanitized_title = sanitize_filename(mg_story_title)
                mg_final_video_name = f"{mg_sanitized_title}_{mg_timestamp}.mp4"
                mg_final_video_upload_path = f"videos/{user_id}/{group_id}/{mg_final_video_name}"

                print(f"MG: uploading final video to {mg_final_video_upload_path}")
                mg_video_uploaded, mg_uploaded_size = upload_file_to_supabase_with_verification(
                    supabase, mg_final_video_path, mg_final_video_upload_path, "videos", "video/mp4")

                if not mg_video_uploaded:
                    if trigger_retry_via_edge_function(supabase_url, supabase_key, video_task_id, user_id, group_id, tab):
                        return add_cors_headers(request, {"status": "retry_triggered", "message": "MG upload failed, retry initiated"})
                    supabase.table("video_tasks").update({
                        "video_creation_status": "error",
                        "overall_status": "error",
                        "error_message": "Failed to upload MG final video",
                        "updated_at": "now()"
                    }).eq("id", video_task_id).execute()
                    return add_cors_headers(request, {"error": "Failed to upload MG final video"}, 500)

                mg_file_size = mg_uploaded_size if mg_uploaded_size > 0 else os.path.getsize(mg_final_video_path)

                try:
                    add_billing_metadata(
                        request,
                        visual_type="mg",
                        total_individual_videos=len(mg_clips),
                        image_amount=len(mg_clips),
                        num_individual_videos=len(mg_clips),
                        has_transitions=False,
                        transition_type=None,
                        has_overlay=False,
                        animation_type=None,
                        effects_type=None,
                        has_subtitles=bool(task.get("subtitles")),
                        use_existing_audio=bool(settings.get("use_existing_audio")),
                        has_video_loop=False,
                        final_assembly=True,
                        use_high_memory=("-high-memory" in (_GCF_SUFFIX or "")),
                        gcf_suffix=_GCF_SUFFIX,
                    )
                except Exception as _mg_meta_err:
                    print(f"[metadata] MG: {_mg_meta_err}")

                if task.get("subtitles"):
                    print("[subtitles] MG video uploaded; dispatching async burn")
                    supabase.table("video_tasks").update({
                        "video_creation_status": "burning_subtitles",
                        "overall_status": "burning_subtitles",
                        "subtitles_status": "pending",
                        "final_video_url": mg_final_video_upload_path,
                        "video_creation_progress": 95,
                        "overall_progress": 95,
                        "updated_at": "now()",
                    }).eq("id", video_task_id).execute()
                    trigger_subtitle_burn_async(
                        supabase_url, supabase_key, video_task_id,
                        user_id, group_id, tab=tab, retry=False)
                    return add_cors_headers(request, {
                        "status": "subtitles_processing",
                        "message": "MG final video uploaded; burning subtitles asynchronously",
                        "video_path": mg_final_video_upload_path,
                        "file_size": mg_file_size,
                        "visual_type": "mg",
                        "total_clips": len(mg_clips),
                    })

                supabase.table("video_tasks").update({
                    "video_creation_status": "completed_final",
                    "overall_status": "completed_final",
                    "individual_video_status": "completed_final",
                    "story_status": "completed_final",
                    "image_prompt_status": "completed_final",
                    "image_generation_status": "completed_final",
                    "audio_status": "completed_final",
                    "overall_progress": 100,
                    "story_progress": 100,
                    "image_prompt_progress": 100,
                    "image_generation_progress": 100,
                    "audio_progress": 100,
                    "video_creation_progress": 100,
                    "individual_video_progress": 100,
                    "final_video_url": mg_final_video_upload_path,
                    "completed_at": "now()",
                    "updated_at": "now()"
                }).eq("id", video_task_id).execute()

                try:
                    mg_next_variant = get_next_video_variant(supabase, user_id, group_id)
                    supabase.table("story_documents").insert({
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "group_id": group_id,
                        "created_at": "now()",
                        "updated_at": "now()",
                        "file_path": mg_final_video_upload_path,
                        "title": settings.get("story_title", "Final Video"),
                        "description": "Final Video",
                        "file_size": mg_file_size,
                        "variant": mg_next_variant,
                        "version": 11,
                        "is_corrected": False,
                        "is_prompted": False,
                        "word_count": 0,
                        "tab": tab
                    }).execute()
                except Exception as mg_metadata_error:
                    print(f"Failed to insert MG story_documents row: {mg_metadata_error}")

                mg_cleanup_success = cleanup_storage_after_completion(
                    supabase_url, supabase_key, user_id, group_id, mg_audio_path)
                delete_task_rows(supabase, user_id, group_id)

                return add_cors_headers(request, {
                    "status": "success",
                    "message": "MG final video created successfully",
                    "video_path": mg_final_video_upload_path,
                    "file_size": mg_file_size,
                    "cleanup_completed": mg_cleanup_success,
                    "visual_type": "mg",
                    "total_clips": len(mg_clips),
                    "has_background_music": mg_bg_music_local_path is not None,
                    "bg_music_volume": mg_bg_music_volume,
                    "tokens_used": mg_tokens_used,
                    "token_limit_reached": not mg_can_add_tokens,
                })


        # UPDATED: Calculate tokens based on transition settings and image count
        # Determine visual_type for correct batch-size / cost calculation
        assembly_visual_type = task.get(
            'visual_type') or settings.get('visual_type') or 'image'

        if not individual_videos_paths:
            # For video loop or when no individual videos are provided
            tokens_to_add = 150000  # Fixed amount for video loop processing
            print(
                f"Video loop or no individual videos - using fixed tokens: {tokens_to_add}")
        else:
            # For regular videos, calculate based on transition settings
            num_images = len(individual_videos_paths)
            tokens_to_add = calculate_transition_tokens(
                num_images, use_transitions, visual_type=assembly_visual_type)

        # Check user token balance and get safe amount to add
        safe_tokens_to_add = check_user_token_balance(
            supabase, user_id, tokens_to_add)

        # Write assembly tokens to a SEPARATE column so the delta-based
        # trigger sees a clean 0→X change (used_tokens was already set by
        # calculate-video-durations; accumulating on the same column caused
        # the trigger delta to be lost).
        tokens_used = safe_tokens_to_add
        can_add_tokens = safe_tokens_to_add > 0

        # Update status to running with assembly token charge
        supabase.table("video_tasks").update({
            "video_creation_status": "running",
            "overall_status": "running",
            "updated_at": "now()"
        }).eq("id", video_task_id).execute()

        print(f"Processing final video for task {video_task_id}")

        # Get audio path, background music, video loop, and model version
        audio_path = settings.get(
            "audio_file_path") or settings.get("audio_folder_path")
        bg_music_url = task.get("bg_music") or settings.get("bg_music")
        bg_music_volume = task.get(
            "bg_music_volume") or settings.get("bg_music_volume", 0.25)
        video_loop_url = task.get("video_loop") or settings.get("video_loop")
        loop_time = task.get("loop_time") or settings.get("loop_time")
        model_version = settings.get("model_version", "v6")

        if not audio_path:
            return add_cors_headers(request, {"error": "Audio path not found in task settings"}, 400)

        print(f"Audio path from settings: {audio_path}")
        print(f"Background music URL: {bg_music_url}")
        print(f"Background music volume: {bg_music_volume}")
        print(f"Video loop URL: {video_loop_url}")
        print(f"Loop time: {loop_time}")
        print(f"Model version: {model_version}")

        # Get individual videos - either from paths or by using video_durations count
        if not individual_videos_paths:
            # Get video count from video_durations field
            # The video_durations field contains a dict like {"1": 205.43, "2": 205.9, ...}
            # The number of keys tells us how many videos exist
            print("Getting video count from video_durations field")
            video_durations = task.get("video_durations", {})

            if video_durations:
                # Count the number of video entries
                video_count = len(video_durations)
                print(f"Found {video_count} videos in video_durations")

                # Generate paths: video_1.mp4, video_2.mp4, ..., video_N.mp4
                individual_videos_paths = [
                    f"videos/{user_id}/{group_id}/individual_videos/video_{i}.mp4"
                    for i in range(1, video_count + 1)
                ]
                print(
                    f"Generated {len(individual_videos_paths)} video paths: video_1.mp4 to video_{video_count}.mp4")
            else:
                return add_cors_headers(request, {"error": "No video_durations found in video task - cannot determine video count"}, 400)

        if not individual_videos_paths:
            return add_cors_headers(request, {"error": "No individual videos found"}, 400)

        print(
            f"Found {len(individual_videos_paths)} individual videos to combine")

        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        with tempfile.TemporaryDirectory() as temp_dir:
            # Download and merge audio files with dynamic extension detection
            print(f"Downloading audio from path: {audio_path}")
            audio_local_path, detected_extension = download_and_merge_audio_files(
                supabase_url, supabase_key, audio_path, temp_dir)

            if not audio_local_path:
                return add_cors_headers(request, {"error": "Failed to download or merge audio files"}, 500)

            print(f"Detected audio format: {detected_extension}")

            # Get audio duration for reference
            audio_duration = get_audio_duration(audio_local_path)
            print(f"Audio duration: {audio_duration} seconds")

            # Download background music if provided
            bg_music_local_path = None
            if bg_music_url:
                bg_music_local_path = download_background_music(
                    bg_music_url, temp_dir)
                if bg_music_local_path:
                    print("Background music downloaded successfully")
                else:
                    print(
                        "Warning: Failed to download background music, proceeding without it")

            # Check if video loop is used
            if video_loop_url:
                print(
                    "Video loop detected, processing loop video in create-final-video with higher memory limit")

                # Check if we need to process the loop (from image-to-video-processor flag)
                if len(individual_videos_paths) == 1 and individual_videos_paths[0] == video_loop_url:
                    print("Processing video loop with higher memory limit")

                    # Download the loop video
                    loop_video_path = download_loop_video(
                        video_loop_url, temp_dir)
                    if not loop_video_path:
                        return add_cors_headers(request, {"error": "Failed to download video loop"}, 500)

                    # Calculate target duration
                    if loop_time:
                        target_duration = loop_time
                    else:
                        target_duration = audio_duration + 10

                    print(
                        f"Creating looped video with target duration: {target_duration} seconds")

                    # Create looped video here
                    looped_video_path = create_looped_video(
                        loop_video_path, target_duration, temp_dir, audio_delay=0.4)

                    if not looped_video_path:
                        return add_cors_headers(request, {"error": "Failed to create looped video"}, 500)

                    # Continue with audio combination using looped_video_path
                    final_video_path = os.path.join(
                        temp_dir, "final_video.mp4")

                    if not combine_loop_video_with_audio(looped_video_path, audio_local_path, bg_music_local_path, final_video_path, bg_music_volume, audio_delay=0.4):
                        return add_cors_headers(request, {"error": "Failed to combine loop video with audio"}, 500)

                else:
                    # For video loop, we should have a single video file
                    if len(individual_videos_paths) == 1 and "video_loop" in individual_videos_paths[0]:
                        loop_video_path = os.path.join(
                            temp_dir, "loop_video.mp4")
                        download_url = f"{supabase_url}/storage/v1/object/videos/{individual_videos_paths[0]}"
                        print(f"Downloading loop video from: {download_url}")

                        if not download_file(download_url, loop_video_path, headers):
                            return add_cors_headers(request, {"error": "Failed to download loop video"}, 500)

                        # Combine loop video with audio and optional background music with 0.4s delay
                        final_video_path = os.path.join(
                            temp_dir, "final_video.mp4")

                        if not combine_loop_video_with_audio(loop_video_path, audio_local_path, bg_music_local_path, final_video_path, bg_music_volume, audio_delay=0.4):
                            return add_cors_headers(request, {"error": "Failed to combine loop video with audio"}, 500)

                    else:
                        return add_cors_headers(request, {"error": "Invalid video loop configuration"}, 500)

            else:
                # Process individual videos
                print("Processing individual videos")

                # Sort video paths naturally to ensure correct order
                individual_videos_paths_sorted = sorted(
                    individual_videos_paths, key=lambda x: natural_sort_key(os.path.basename(x)))

                # NEW: Check for large video count with transitions - trigger batch processing
                # Batch size: 12 for TTV/ITV, 6 for images
                visual_type_for_batch = task.get(
                    'visual_type') or settings.get('visual_type') or 'image'
                batch_size_for_transitions = 12 if visual_type_for_batch in (
                    'ttv', 'itv') else 6
                if use_transitions and len(individual_videos_paths_sorted) > batch_size_for_transitions:
                    print(
                        f"Large video count ({len(individual_videos_paths_sorted)}) with transitions detected - using internal batch processing (batch_size={batch_size_for_transitions})")

                    # Initialize transition batch progress
                    total_batches = (
                        len(individual_videos_paths_sorted) + batch_size_for_transitions - 1) // batch_size_for_transitions

                    supabase.table("video_tasks").update({
                        "transition_batch_progress": {
                            "total_batches": total_batches,
                            "completed_batches": 0,
                            "batch_outputs": [],
                            "total_videos": len(individual_videos_paths_sorted)
                        },
                        "video_creation_status": "running",
                        "updated_at": "now()"
                    }).eq("id", video_task_id).execute()

                    print(
                        f"Starting transition batch processing with {total_batches} batches ({batch_size_for_transitions} videos each)")

                    # Start processing first batch
                    result = process_transition_batches_internal(
                        supabase, video_task_id, user_id, group_id,
                        individual_videos_paths_sorted, transition_type,
                        transition_duration, temp_dir, continue_from_batch=1, tab=tab, visual_type=visual_type_for_batch)

                    if result["status"] == "retry_triggered":
                        return add_cors_headers(request, {
                            "status": "retry_triggered",
                            "message": result["message"],
                            "failed_batch": result["failed_batch"]
                        })
                    elif result["status"] == "continuing":
                        return add_cors_headers(request, {
                            "status": "success",
                            "message": "Transition batch processing initiated for large video count",
                            "total_videos": len(individual_videos_paths_sorted),
                            "total_batches": total_batches,
                            "processed_batches": result["processed_batches"],
                            "next_batch": result["next_batch"],
                            "transition_processing": True
                        })
                    elif result["status"] == "completed":
                        # All batches done in one go (shouldn't happen with >6 videos but just in case)
                        try:
                            requests.post(
                                f"{supabase_url}/functions/v1/process-transition-batches",
                                headers={
                                    "Content-Type": "application/json",
                                    "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                                    "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                                },
                                json={
                                    "video_task_id": video_task_id,
                                    "user_id": user_id,
                                    "group_id": group_id,
                                    "final_assembly": True,
                                    "tab": tab
                                }
                            )
                        except Exception as e:
                            print(
                                f"Fire-and-forget trigger for final assembly: {str(e)}")

                        return add_cors_headers(request, {
                            "status": "success",
                            "message": "All transition batches completed, final assembly triggered",
                            "total_batches": total_batches,
                            "transition_processing": True
                        })

                # Download individual videos for smaller counts or no transitions
                local_video_files = []
                for idx, video_path in enumerate(individual_videos_paths_sorted, start=1):
                    local_path = os.path.join(temp_dir, f"video_{idx:03d}.mp4")
                    download_url = f"{supabase_url}/storage/v1/object/videos/{video_path}"
                    print(f"Downloading {download_url}")

                    if download_file(download_url, local_path, headers):
                        local_video_files.append(local_path)
                        print(f"Downloaded video {idx}")
                    else:
                        print(f"Failed to download video {idx}")

                if not local_video_files:
                    return add_cors_headers(request, {"error": "No videos downloaded"}, 500)

                # ── TTV/ITV speech audio download ───────────────────
                # Speed adjustment is now handled by image-to-video-processor.
                # Speech audio files are saved alongside videos as audio_{N}.aac.
                visual_type = task.get('visual_type') or settings.get(
                    'visual_type') or 'image'
                clip_assembly_data = task.get('clip_assembly_data')
                use_speech_assembly = False
                actual_durations_for_assembly = None
                clip_audio_files_for_assembly = None

                if clip_assembly_data and visual_type in ('ttv', 'itv'):
                    has_speech_list = clip_assembly_data.get('has_speech', [])
                    speed_factors = clip_assembly_data.get('speed_factors', [])

                    if any(has_speech_list):
                        print(f"\n=== TTV/ITV: downloading speech audio files ===")
                        clip_audios = []
                        actual_durs = []

                        for idx in range(len(local_video_files)):
                            clip_num = idx + 1
                            # Get actual duration of the (already speed-adjusted) video
                            dur = get_video_duration(local_video_files[idx])
                            if dur is None:
                                dur = 5.0
                            actual_durs.append(dur)

                            # Download audio for ALL clips (matching SSAIVidGen.py)
                            audio_path = f"videos/{user_id}/{group_id}/individual_videos/audio_{clip_num}.aac"
                            local_audio = os.path.join(
                                temp_dir, f"speech_{clip_num:03d}.aac")
                            audio_url = f"{supabase_url}/storage/v1/object/videos/{audio_path}"
                            if download_file(audio_url, local_audio, headers):
                                clip_audios.append((idx, local_audio, dur))
                                is_speech = has_speech_list[idx] if idx < len(
                                    has_speech_list) else False
                                tag = "🗣️" if is_speech else "🔇"
                                print(
                                    f"  {tag} Downloaded audio for clip {clip_num}")
                            else:
                                print(
                                    f"  ⚠️ Audio not found for clip {clip_num}")

                        if clip_audios:
                            use_speech_assembly = True
                            actual_durations_for_assembly = actual_durs
                            clip_audio_files_for_assembly = clip_audios
                            print(f"  Speech audio ready: {len(clip_audios)} tracks, "
                                  f"total video duration: {sum(actual_durs):.2f}s")
                        else:
                            print(
                                "  No speech audio files found, using standard audio mix")

                # Concatenate videos based on whether transitions are enabled
                concatenated_video_path = os.path.join(
                    temp_dir, "concatenated.mp4")

                if use_transitions:
                    # Use simple transition processing for smaller counts
                    print("Using simple transition processing...")

                    # Get video durations for transition timing
                    video_durations = []
                    for video_file in local_video_files:
                        duration = get_video_duration(video_file)
                        video_durations.append(duration)
                        print(
                            f"Video {os.path.basename(video_file)} duration: {duration}s")

                    concat_success = concatenate_videos_with_transitions(
                        local_video_files, concatenated_video_path, transition_type, transition_duration, video_durations)
                else:
                    # Use simple concatenation (original working method)
                    print("Using simple concatenation without transitions...")
                    concat_success = concatenate_videos_simple(
                        local_video_files, concatenated_video_path)

                if not concat_success:
                    return add_cors_headers(request, {"error": "Video concatenation failed"}, 500)

                # ── Speech-aware audio assembly (TTV/ITV with audio_clip) ──
                final_video_path = os.path.join(temp_dir, "final_video.mp4")
                ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")

                speech_audio_done = False
                if use_speech_assembly and actual_durations_for_assembly:
                    speech_audio_done = assemble_speech_audio(
                        concatenated_video_path, audio_local_path,
                        clip_audio_files_for_assembly, clip_assembly_data,
                        actual_durations_for_assembly,
                        use_transitions, transition_duration,
                        bg_music_local_path, bg_music_volume,
                        final_video_path, ffmpeg_path, temp_dir
                    )
                    if not speech_audio_done:
                        print("Speech audio assembly failed — "
                              "falling back to standard audio combination")

                try:
                    if speech_audio_done:
                        pass  # Audio already combined by speech assembly
                    elif bg_music_local_path:
                        # Single-pass mux: video + narration + bg-music in ONE
                        # ffmpeg invocation. Avoids writing a ~5GB intermediate
                        # `video_with_narration.mp4` to /tmp (which is RAM-backed
                        # in GCF and overflows for multi-hour outputs).
                        video_dur = get_video_duration(concatenated_video_path)
                        print(f"Video duration for bg music mix: {video_dur}s")

                        subprocess.run([
                            ffmpeg_path, '-y',
                            '-i', concatenated_video_path,
                            '-i', audio_local_path,
                            '-i', bg_music_local_path,
                            '-filter_complex',
                            f'[1:a]volume=1.0,apad=whole_dur={video_dur}[narr];'
                            f'[2:a]volume={bg_music_volume},aloop=loop=-1:size=2e+09,atrim=end={video_dur}[music];'
                            f'[narr][music]amix=inputs=2:duration=shortest:dropout_transition=3:normalize=0[aout]',
                            '-map', '0:v:0',
                            '-map', '[aout]',
                            '-c:v', 'copy',
                            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                            '-avoid_negative_ts', 'make_zero',
                            '-fflags', '+genpts',
                            '-movflags', '+faststart',
                            final_video_path
                        ], check=True, capture_output=True)
                        print(
                            "Video created with narration and background music (single-pass)")
                    else:
                        # No background music - simple audio mapping (matching SSAIVidGen.py)
                        # Video is padded 5s beyond audio so it always wins; no need for
                        # silence padding or adelay — just map the audio directly.
                        subprocess.run([
                            ffmpeg_path, '-y', '-i', concatenated_video_path, '-i', audio_local_path,
                            '-c:v', 'copy',
                            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                            '-map', '0:v:0', '-map', '1:a:0',
                            '-avoid_negative_ts', 'make_zero',
                            '-fflags', '+genpts',
                            '-movflags', '+faststart',
                            final_video_path
                        ], check=True, capture_output=True)
                        print(
                            "Video created with narration audio (SSAIVidGen.py method)")

                except subprocess.CalledProcessError as e:
                    print(
                        f"FFmpeg audio/video combination error: {e.stderr.decode()}")
                    return add_cors_headers(request, {"error": f"Audio/video combination failed: {e.stderr.decode()}"}, 500)
                except subprocess.TimeoutExpired:
                    return add_cors_headers(request, {"error": "Audio/video combination timed out"}, 500)

            # Generate output file paths
            timestamp = time.strftime("%Y-%m-%d_%H-%M-%S")
            story_title = settings.get("story_title", "video")

            # Sanitize the story title for storage
            sanitized_title = sanitize_filename(story_title)

            # Final video path
            final_video_name = f"{sanitized_title}_{timestamp}.mp4"
            final_video_upload_path = f"videos/{user_id}/{group_id}/{final_video_name}"

            print(f"Uploading final video to {final_video_upload_path}")

            # ── Subtitles burn is now done ASYNCHRONOUSLY in a separate
            # create-final-video invocation triggered after upload, so the
            # initial render isn't blocked by the multi-minute re-encode.

            # Upload final video with verification and retry logic
            video_uploaded, uploaded_file_size = upload_file_to_supabase_with_verification(
                supabase, final_video_path, final_video_upload_path, 'videos', 'video/mp4')

            if video_uploaded:
                print("Final video uploaded successfully")

                # Use the file size from verification if available, otherwise get from local file
                file_size = uploaded_file_size if uploaded_file_size > 0 else os.path.getsize(
                    final_video_path)

                # ── Async subtitle burn dispatch (main path) ────────────────
                _subs_cfg = None
                try:
                    _subs_row = supabase.table("video_tasks").select(
                        "subtitles").eq("id", video_task_id).single().execute()
                    _subs_cfg = (_subs_row.data or {}).get("subtitles")
                except Exception as _e:
                    print(
                        f"[subtitles] could not check subtitles config: {_e}")
                if _subs_cfg:
                    print(
                        "[subtitles] uploaded un-subtitled video; dispatching async burn")
                    supabase.table("video_tasks").update({
                        "video_creation_status": "burning_subtitles",
                        "overall_status": "burning_subtitles",
                        "subtitles_status": "pending",
                        "final_video_url": final_video_upload_path,
                        "video_creation_progress": 95,
                        "overall_progress": 95,
                        "updated_at": "now()",
                    }).eq("id", video_task_id).execute()
                    trigger_subtitle_burn_async(
                        supabase_url, supabase_key, video_task_id,
                        user_id, group_id, tab=tab, retry=False)
                    return add_cors_headers(request, {
                        "status": "subtitles_processing",
                        "message": "Final video uploaded; burning subtitles asynchronously",
                        "video_path": final_video_upload_path,
                        "file_size": file_size,
                    })

                # Update main video task with completion and set all status to completed_final
                update_data = {
                    "video_creation_status": "completed_final",
                    "overall_status": "completed_final",
                    "individual_video_status": "completed_final",
                    "story_status": "completed_final",
                    "image_prompt_status": "completed_final",
                    "image_generation_status": "completed_final",
                    "audio_status": "completed_final",
                    "overall_progress": 100,
                    "story_progress": 100,
                    "image_prompt_progress": 100,
                    "image_generation_progress": 100,
                    "audio_progress": 100,
                    "video_creation_progress": 100,
                    "individual_video_progress": 100,
                    "final_video_url": final_video_upload_path,
                    "completed_at": "now()",
                    "updated_at": "now()"
                }

                supabase.table("video_tasks").update(
                    update_data).eq("id", video_task_id).execute()

                # Update all batch tasks to completed_final with 100% progress
                supabase.table("video_tasks").update({
                    "video_creation_status": "completed_final",
                    "overall_status": "completed_final",
                    "individual_video_status": "completed_final",
                    "story_status": "completed_final",
                    "image_prompt_status": "completed_final",
                    "image_generation_status": "completed_final",
                    "audio_status": "completed_final",
                    "overall_progress": 100,
                    "story_progress": 100,
                    "image_prompt_progress": 100,
                    "image_generation_progress": 100,
                    "audio_progress": 100,
                    "video_creation_progress": 100,
                    "individual_video_progress": 100,
                    "updated_at": "now()"
                }).eq("user_id", user_id).eq("group_id", group_id).execute()

                print(
                    "Updated all video tasks to completed_final status with 100% progress")

                # Insert metadata BEFORE cleanup - prevents loss if function times out during cleanup
                try:
                    next_variant = get_next_video_variant(
                        supabase, user_id, group_id)
                    supabase.table("story_documents").insert({
                        "id": str(uuid.uuid4()),
                        "user_id": user_id,
                        "group_id": group_id,
                        "created_at": "now()",
                        "updated_at": "now()",
                        "file_path": final_video_upload_path,
                        "title": settings.get("story_title", "Final Video"),
                        "description": "Final Video",
                        "file_size": file_size,
                        "variant": next_variant,
                        "version": 11,
                        "is_corrected": False,
                        "is_prompted": False,
                        "word_count": 0,
                        "tab": tab
                    }).execute()
                    print(
                        "Metadata inserted to story_documents with 'Final Video' description")
                except Exception as metadata_error:
                    print(f"Failed to insert metadata: {str(metadata_error)}")

                # CLEANUP AFTER metadata insert so a timeout here doesn't lose the record
                print("Starting cleanup of individual videos and audio files...")
                cleanup_success = cleanup_storage_after_completion(
                    supabase_url, supabase_key, user_id, group_id, audio_path
                )

                # Delete intermediate task rows now that video is complete
                delete_task_rows(supabase, user_id, group_id)

                response_data = {
                    "status": "success",
                    "message": "Final video created successfully",
                    "video_path": final_video_upload_path,
                    "file_size": file_size,
                    "cleanup_completed": cleanup_success,
                    "has_background_music": bg_music_local_path is not None,
                    "bg_music_volume": bg_music_volume,
                    "has_video_loop": bool(video_loop_url),
                    "loop_time": loop_time,
                    "audio_delay": 0.4,
                    "detected_audio_format": detected_extension,
                    "model_version": model_version,
                    "transition_type": transition_type if use_transitions else None,
                    "transition_duration": transition_duration if use_transitions else None,
                    "has_transitions": use_transitions and len(individual_videos_paths) > 1 and not video_loop_url,
                    # CHANGED: from 10 to 6
                    "batch_processing_used": use_transitions and len(individual_videos_paths) > 6 and not video_loop_url,
                    "tokens_used": tokens_used,
                    "token_limit_reached": not can_add_tokens
                }

                if not cleanup_success:
                    response_data["warning"] = "Final video created but some cleanup operations failed"

                return add_cors_headers(request, response_data)

            else:
                # Trigger retry via edge function
                if trigger_retry_via_edge_function(supabase_url, supabase_key, video_task_id, user_id, group_id, tab):
                    return add_cors_headers(request, {"status": "retry_triggered", "message": "Upload failed, retry initiated"})
                else:
                    # Update task with upload error
                    supabase.table("video_tasks").update({
                        "video_creation_status": "error",
                        "overall_status": "error",
                        "error_message": "Failed to upload final video",
                        "updated_at": "now()"
                    }).eq("id", video_task_id).execute()

                    return add_cors_headers(request, {"error": "Failed to upload final video"}, 500)

    except Exception as e:
        print(f"General error: {str(e)}")

        # Update task with error
        try:
            supabase.table("video_tasks").update({
                "video_creation_status": "error",
                "overall_status": "error",
                "error_message": f"Final video creation failed: {str(e)}",
                "updated_at": "now()"
            }).eq("id", video_task_id).execute()
        except:
            pass

        return add_cors_headers(request, {"error": f"Error: {str(e)}"}, 500)
