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
import difflib
import string
from typing import List, Tuple, Optional, Dict
import random
from difflib import get_close_matches
import fal_client
import math  # Added for STT token calculation
# Added for parallel processing
from concurrent.futures import ThreadPoolExecutor, as_completed
from _billing import billed, add_billing_metadata


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


def calculate_stt_tokens(audio_duration_seconds):
    """Calculate STT tokens based on audio duration and chunk limits"""
    MAX_DURATION_SECONDS = 540  # 9 minutes per STT call
    TOKENS_PER_STT_CALL = 2500

    if audio_duration_seconds <= 0:
        return 0

    if audio_duration_seconds <= MAX_DURATION_SECONDS:
        return TOKENS_PER_STT_CALL  # Single STT call
    else:
        # Calculate how many STT calls needed
        num_chunks = math.ceil(audio_duration_seconds / MAX_DURATION_SECONDS)
        return num_chunks * TOKENS_PER_STT_CALL


def get_stt_language_code(text_language: str) -> str:
    """Convert text_language to ISO 639-1 language code for STT API"""
    language_map = {
        'english': 'en',
        'french': 'fr',
        'spanish': 'es',
        'german': 'de'
    }
    return language_map.get(text_language.lower(), 'en')  # default to 'en'


def sanitize_storage_path(storage_path: str) -> str:
    """Sanitize storage path while preserving file extension"""
    # Split on last dot to separate name and extension
    path_parts = storage_path.rsplit('.', 1)

    if len(path_parts) == 2:
        name_part, extension = path_parts
        # Sanitize only the name part
        sanitized_name = name_part.replace('.', '_').replace(' ', '_').replace(
            '(', '_').replace(')', '_').replace('[', '_').replace(']', '_')
        return f"{sanitized_name}.{extension}"
    else:
        # No extension found, sanitize the whole path
        return storage_path.replace('.', '_').replace(' ', '_').replace(
            '(', '_').replace(')', '_').replace('[', '_').replace(']', '_')


def download_file(url, local_path, headers):
    """Download a file with retry logic"""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.get(
                url, headers=headers, stream=True)
            response.raise_for_status()

            with open(local_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
            return True
        except Exception as e:
            print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(5)
    return False


def get_audio_file_extension(model_version):
    """Get the correct audio file extension based on model version"""
    if model_version == 'v7':
        return '.mp3'
    else:  # v6, clone, or default
        return '.wav'


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
        return successful_deletions > 0

    except Exception as e:
        print(f"Error deleting folder {folder_path}: {str(e)}")
        return False


def handle_stop_request(supabase, video_task_id, user_id, group_id):
    """Handle stop request for video processing"""
    try:
        print(f"Processing stop request for video task {video_task_id}")

        # Get Supabase credentials
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")

        # Update main task to cancelled
        supabase.table("video_tasks").update({
            "video_creation_status": "cancelled",
            "individual_video_status": "cancelled",
            "overall_status": "cancelled",
            "error_message": "Video generation stopped by user",
            "updated_at": "now()"
        }).eq("id", video_task_id).execute()

        # Update all batch tasks to cancelled
        supabase.table("video_tasks").update({
            "video_creation_status": "cancelled",
            "individual_video_status": "cancelled",
            "overall_status": "cancelled",
            "error_message": "Video generation stopped by user",
            "updated_at": "now()"
        }).eq("doc_id", video_task_id).execute()

        # Clean up individual videos folder
        individual_videos_folder = f"videos/{user_id}/{group_id}/individual_videos"
        print(
            f"Cleaning up individual videos folder: {individual_videos_folder}")

        cleanup_success = delete_folder_from_supabase(
            supabase_url, supabase_key, "videos", individual_videos_folder
        )

        if cleanup_success:
            print("Individual videos folder cleaned up successfully")
        else:
            print("Warning: Individual videos folder cleanup may have failed")

        return {
            "status": "stopped",
            "message": "Video processing stopped and cleaned up successfully",
            "cleanup_success": cleanup_success
        }

    except Exception as e:
        print(f"Error handling stop request: {str(e)}")
        return {
            "status": "error",
            "message": f"Error stopping video processing: {str(e)}",
            "cleanup_success": False
        }


def natural_sort_key(s):
    """Key for natural sorting of filenames (e.g., 1.png before 10.png)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]


def create_optimized_long_video(image_path, output_path, duration, animation_type, overlay_path=None,
                                overlay_available=False, transparency=0.3):
    """
    Create long video using optimized approach: create 2 base videos (L→R, R→L) and concat pattern.
    This is ~95% faster than creating individual segments.

    Args:
        image_path: Path to source image
        output_path: Path for final video output
        duration: Total video duration in seconds
        animation_type: 'drift' (horizontal), 'vertical', or 'none'
        overlay_path: Optional path to overlay video
        overlay_available: Whether overlay should be applied
        transparency: Overlay transparency (0.0-1.0)

    Returns:
        bool: True if successful, False otherwise
    """
    try:
        BASE_DURATION = 20.0  # Match DRIFT_SEGMENT_DURATION
        FPS = 60
        TARGET_WIDTH = 1920
        TARGET_HEIGHT = 1080

        print(
            f"🚀 Creating optimized long video: {duration}s using base+concat method")

        # Calculate how many segments we need
        num_segments = math.ceil(duration / BASE_DURATION)

        # Create temporary directory for base videos.
        # IMPORTANT: filenames must be namespaced per output_path because
        # multiple workers (ThreadPoolExecutor max_workers=3) share temp_dir
        # and would otherwise overwrite each other's base files mid-flight,
        # producing truncated MP4s ("moov atom not found" / "no streams").
        temp_dir = os.path.dirname(output_path)
        unique_prefix = os.path.splitext(os.path.basename(output_path))[0]
        base_video_1 = os.path.join(
            temp_dir, f"{unique_prefix}_base_left_to_right.mp4")
        base_video_2 = os.path.join(
            temp_dir, f"{unique_prefix}_base_right_to_left.mp4")
        concat_file = os.path.join(
            temp_dir, f"{unique_prefix}_concat_list.txt")

        # Step 1: Create 2 base videos (one for each direction)
        print(f"   Creating base video 1 (L→R)...")
        if animation_type == 'drift':
            success_1 = create_directional_video_crop(
                image_path, 'left_to_right', BASE_DURATION, FPS, TARGET_WIDTH, TARGET_HEIGHT,
                overlay_path if overlay_available else None, transparency, base_video_1
            )
        elif animation_type == 'vertical':
            success_1 = create_directional_video_crop(
                image_path, 'top_to_bottom', BASE_DURATION, FPS, TARGET_WIDTH, TARGET_HEIGHT,
                overlay_path if overlay_available else None, transparency, base_video_1
            )
        else:  # 'none'
            if overlay_available and overlay_path:
                success_1 = create_video_from_image_with_overlay_and_transparency(
                    image_path, overlay_path, base_video_1, BASE_DURATION, 'none', transparency
                )
            else:
                success_1 = create_video_from_image_no_overlay(
                    image_path, base_video_1, BASE_DURATION, 'none'
                )

        if not success_1:
            print("❌ Failed to create base video 1")
            return False

        print(f"   Creating base video 2 (R→L)...")
        if animation_type == 'drift':
            success_2 = create_directional_video_crop(
                image_path, 'right_to_left', BASE_DURATION, FPS, TARGET_WIDTH, TARGET_HEIGHT,
                overlay_path if overlay_available else None, transparency, base_video_2
            )
        elif animation_type == 'vertical':
            success_2 = create_directional_video_crop(
                image_path, 'bottom_to_top', BASE_DURATION, FPS, TARGET_WIDTH, TARGET_HEIGHT,
                overlay_path if overlay_available else None, transparency, base_video_2
            )
        else:  # 'none' - reuse same video
            base_video_2 = base_video_1
            success_2 = True

        if not success_2:
            print("❌ Failed to create base video 2")
            return False

        # Step 2: Create concat file with alternating pattern
        print(f"   Creating concat file for {num_segments} segments...")
        with open(concat_file, 'w') as f:
            for i in range(num_segments):
                # Alternate between base videos
                if animation_type == 'none':
                    f.write(f"file '{base_video_1}'\n")
                else:
                    if i % 2 == 0:
                        f.write(f"file '{base_video_1}'\n")
                    else:
                        f.write(f"file '{base_video_2}'\n")

        # Step 3: Concatenate videos
        print(f"   Concatenating {num_segments} segments...")
        temp_full = output_path.replace('.mp4', '_temp_full.mp4')

        # Use +genpts so any DTS gaps across segment boundaries are regenerated,
        # and avoid_negative_ts to keep timestamps monotonic for downstream tools.
        concat_cmd = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-fflags', '+genpts',
            '-f', 'concat', '-safe', '0',
            '-i', concat_file,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            temp_full
        ]

        subprocess.run(concat_cmd, check=True, capture_output=True, text=True)

        # Step 4: Trim to exact duration if needed
        exact_duration = duration
        full_duration = num_segments * BASE_DURATION

        if abs(full_duration - exact_duration) > 0.1:  # Need trimming
            print(f"   Trimming from {full_duration}s to {exact_duration}s...")

            # First try a fast stream-copy trim. This only works cleanly when the
            # cut lands on a keyframe; if it fails (non-monotonic DTS, invalid
            # data at a non-keyframe boundary, etc.) we fall back to a re-encode
            # trim which is robust at any cut point.
            fast_trim_cmd = [
                'ffmpeg', '-y', '-loglevel', 'error',
                '-i', temp_full,
                '-t', str(exact_duration),
                '-c', 'copy',
                '-avoid_negative_ts', 'make_zero',
                '-movflags', '+faststart',
                output_path
            ]
            try:
                subprocess.run(fast_trim_cmd, check=True,
                               capture_output=True, text=True)
            except subprocess.CalledProcessError as fast_err:
                fast_stderr = (fast_err.stderr or '').strip()
                print(
                    f"   ⚠️ Fast stream-copy trim failed, falling back to re-encode trim. ffmpeg stderr: {fast_stderr}")
                if os.path.exists(output_path):
                    try:
                        os.remove(output_path)
                    except OSError:
                        pass
                reencode_trim_cmd = [
                    'ffmpeg', '-y', '-loglevel', 'error',
                    '-i', temp_full,
                    '-t', str(exact_duration),
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                    '-pix_fmt', 'yuv420p',
                    '-r', str(FPS),
                    '-an',
                    '-movflags', '+faststart',
                    output_path
                ]
                subprocess.run(reencode_trim_cmd, check=True,
                               capture_output=True, text=True)

            # Clean up temp full video
            if os.path.exists(temp_full):
                os.remove(temp_full)
        else:
            # No trimming needed, just rename
            os.rename(temp_full, output_path)

        # Clean up base videos and concat file
        if os.path.exists(base_video_1):
            os.remove(base_video_1)
        if animation_type != 'none' and os.path.exists(base_video_2) and base_video_2 != base_video_1:
            os.remove(base_video_2)
        if os.path.exists(concat_file):
            os.remove(concat_file)

        print(f"✅ Successfully created optimized long video: {duration}s")
        return True

    except subprocess.CalledProcessError as e:
        # Surface ffmpeg's actual stderr — previously this was swallowed by
        # capture_output=True, leaving us with just the command line in the log.
        stderr_text = (e.stderr or '').strip() if hasattr(e, 'stderr') else ''
        stdout_text = (e.stdout or '').strip() if hasattr(e, 'stdout') else ''
        print(
            f"❌ Error creating optimized long video (ffmpeg returned {e.returncode}). cmd={e.cmd}")
        if stderr_text:
            print(f"   ffmpeg stderr: {stderr_text}")
        if stdout_text:
            print(f"   ffmpeg stdout: {stdout_text}")
        import traceback
        traceback.print_exc()
        return False

    except Exception as e:
        print(f"❌ Error creating optimized long video: {str(e)}")
        import traceback
        traceback.print_exc()
        return False


def process_single_image(image_number, batch_start, batch_end, durations_dict, supabase_url, supabase_key,
                         images_folder_path, temp_dir, effects_type, overlay_path, overlay_available,
                         overlay_configs, animation_type, user_id, group_id, supabase,
                         batch_number=None, video_task_id=None, output_video_name=None):
    """Process a single image: download, create video, and upload - designed for parallel execution
    For long videos (≥120s), uses optimized base+concat method for 90-95% time savings.
    """
    max_retries = 2

    for retry_attempt in range(max_retries):
        try:
            print(
                f"\n{' Retry' if retry_attempt > 0 else ' Processing'} image {image_number} (attempt {retry_attempt + 1}/{max_retries})")

            # Get duration for this specific image
            duration = 5.0  # Default
            if durations_dict and str(image_number) in durations_dict:
                duration = float(durations_dict[str(image_number)])
                print(
                    f"[Worker] Using Enhanced FAL-AI STT duration for image {image_number}: {duration}s")
            else:
                print(
                    f"[Worker] Using default duration for image {image_number}: {duration}s")

            # Download the specific image
            headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
            image_filename = f"{image_number}.png"
            image_url = f"{supabase_url}/storage/v1/object/stories/{images_folder_path}/{image_filename}"
            image_path = os.path.join(temp_dir, image_filename)

            print(
                f"[Worker] Downloading image {image_number} from: {image_url}")

            if not download_file(image_url, image_path, headers):
                print(f"[Worker] Failed to download image {image_number}")
                if retry_attempt == max_retries - 1:
                    return {'success': False, 'image_number': image_number, 'error': 'Download failed'}
                continue

            # Create video path
            video_path = os.path.join(
                temp_dir, f"video_{image_number}_attempt_{retry_attempt + 1}.mp4")

            print(
                f"[Worker] Creating video for image {image_number} (duration: {duration}s, animation: {animation_type}, effects: {effects_type})")

            # Determine video creation method.
            # Note: ken_burns is intentionally excluded from the optimized
            # base+concat path because it needs a fresh zoompan render per
            # 12s segment to preserve the zoom-in/zoom-out alternation.
            use_optimized = duration >= 120.0 and animation_type in [
                'drift', 'vertical']

            if use_optimized:
                # Use optimized base+concat method for long videos
                print(
                    f"[Worker] 🚀 Using optimized creation for {duration}s video")
                overlay_transparency = overlay_configs.get(
                    effects_type, {}).get('transparency', 0.30)
                success = create_optimized_long_video(
                    image_path, video_path, duration, animation_type,
                    overlay_path if overlay_available and effects_type and effects_type != 'none' else None,
                    overlay_available and effects_type and effects_type != 'none',
                    overlay_transparency
                )
            elif effects_type is not None and effects_type != 'none' and overlay_available:
                # Regular creation with overlay
                overlay_transparency = overlay_configs.get(
                    effects_type, {}).get('transparency', 0.30)
                success = create_video_from_image_with_overlay_and_transparency(
                    image_path, overlay_path, video_path, duration, animation_type, overlay_transparency)
            else:
                # Regular creation without overlay
                success = create_video_from_image_no_overlay(
                    image_path, video_path, duration, animation_type)

            if not success:
                print(
                    f"[Worker] Failed to create video from image {image_number} on attempt {retry_attempt + 1}")
                if retry_attempt == max_retries - 1:
                    return {'success': False, 'image_number': image_number, 'error': 'Video creation failed'}
                continue

            # Upload video to storage with retry logic
            video_folder = f"videos/{user_id}/{group_id}/individual_videos"
            upload_path = f"{video_folder}/video_{image_number}.mp4"

            if upload_video_to_supabase(supabase, video_path, upload_path):
                print(
                    f"[Worker] ✅ Successfully uploaded video for image {image_number}")
                return {
                    'success': True,
                    'image_number': image_number,
                    'video_path': upload_path,
                    'duration': duration
                }
            else:
                print(
                    f"[Worker] Failed to upload video for image {image_number} on attempt {retry_attempt + 1}")
                if retry_attempt == max_retries - 1:
                    return {'success': False, 'image_number': image_number, 'error': 'Upload failed'}

        except Exception as e:
            print(
                f"[Worker] Error processing image {image_number} on attempt {retry_attempt + 1}: {str(e)}")
            if retry_attempt == max_retries - 1:
                return {'success': False, 'image_number': image_number, 'error': str(e)}

    return {'success': False, 'image_number': image_number, 'error': 'All retries failed'}


def build_atempo_chain(sf):
    """Build ffmpeg atempo filter chain for speed factor.
    atempo only supports 0.5–2.0 per stage, so chain stages for extreme values."""
    if sf <= 0:
        return 'atempo=1.0'
    if abs(sf - 1.0) < 0.01:
        return 'atempo=1.0'
    if sf <= 0.5:
        return f'atempo=0.5,atempo={sf / 0.5:.6f}'
    if sf < 0.5:
        return f'atempo={sf * 2:.6f},atempo=0.5'
    if sf > 2.0:
        return f'atempo=2.0,atempo={sf / 2.0:.6f}'
    return f'atempo={sf:.6f}'


def apply_overlay_to_video_clip(input_video_path, overlay_path, output_path,
                                duration, transparency=0.30):
    """Apply an overlay video on top of an existing video clip (for TTV/ITV).
    Extends the overlay by looping if needed, then composites with transparency."""
    try:
        target_width = 1920
        target_height = 1080

        # Build ffmpeg command: scale base video, loop overlay, composite
        filter_complex = (
            f"[0:v]scale={target_width}:{target_height}:force_original_aspect_ratio=increase,"
            f"crop={target_width}:{target_height},setpts=PTS-STARTPTS[base];"
            f"[1:v]scale={target_width}:{target_height},loop=-1:size=32767:start=0,"
            f"setpts=PTS-STARTPTS,format=yuva420p,"
            f"colorchannelmixer=aa={transparency}[ovr];"
            f"[base][ovr]overlay=0:0:shortest=1"
        )

        cmd = [
            'ffmpeg', '-y', '-loglevel', 'error',
            '-i', input_video_path,
            '-i', overlay_path,
            '-filter_complex', filter_complex,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-t', str(duration),
            '-pix_fmt', 'yuv420p', '-r', '30',
            '-movflags', '+faststart', '-an', output_path
        ]

        subprocess.run(cmd, check=True, capture_output=True)

        if verify_video_file(output_path):
            print(f"  ✅ Overlay applied successfully")
            return True
        else:
            print(f"  ❌ Overlay output verification failed")
            return False

    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"  ❌ Overlay application failed: {e}")
        return False


def process_single_ttv_clip(clip_number, clip_filename, supabase_url, supabase_key,
                            clips_folder_path, temp_dir, clip_assembly_data,
                            effects_type, overlay_path, overlay_available,
                            overlay_configs, user_id, group_id, supabase):
    """Process a single TTV/ITV clip: download, speed-adjust, apply overlay, upload.
    Mirrors process_single_image but for pre-existing video clips.

    Args:
        clip_number: 1-based clip index
        clip_filename: The actual filename of the clip (e.g., '1.mp4', 'clip_1.mp4')
    """
    max_retries = 2

    for retry_attempt in range(max_retries):
        try:
            print(f"\n{'  Retry' if retry_attempt > 0 else '  Processing'} "
                  f"TTV/ITV clip {clip_number} (attempt {retry_attempt + 1}/{max_retries})")

            # Download the clip from stories bucket
            headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
            download_url = f"{supabase_url}/storage/v1/object/stories/{clips_folder_path}/{clip_filename}"
            local_clip_path = os.path.join(
                temp_dir, f"clip_{clip_number:03d}.mp4")

            print(f"  Downloading clip {clip_number}: {clip_filename}")
            if not download_file(download_url, local_clip_path, headers):
                print(f"  ❌ Failed to download clip {clip_number}")
                if retry_attempt == max_retries - 1:
                    return {'success': False, 'clip_number': clip_number, 'error': 'Download failed'}
                continue

            # Get speed factor from clip_assembly_data
            speed_factors = clip_assembly_data.get('speed_factors', [])
            has_speech = clip_assembly_data.get('has_speech', [])
            target_durations = clip_assembly_data.get('target_durations', [])
            is_speech = has_speech[clip_number -
                                   1] if (clip_number - 1) < len(has_speech) else False

            natural_dur = get_video_duration(local_clip_path)
            if natural_dur is None:
                natural_dur = 5.0

            # Determine speed factor: prefer pre-computed, fall back to target_durations
            if (clip_number - 1) < len(speed_factors) and speed_factors:
                sf = speed_factors[clip_number - 1]
            elif (clip_number - 1) < len(target_durations) and target_durations:
                # Compute speed factor on the fly from natural_dur / target_dur
                target_dur = target_durations[clip_number - 1]
                sf = natural_dur / target_dur if target_dur > 0 else 1.0
                sf = max(0.25, min(4.0, sf))
                print(f"  Computed sf on-the-fly for clip {clip_number}: "
                      f"natural={natural_dur:.2f}s / target={target_dur:.2f}s = {sf:.3f}")
            else:
                sf = 1.0

            actual_dur = natural_dur / sf if sf > 0 else natural_dur

            tag = "🗣️" if is_speech else "  "
            print(f"  {tag} Clip {clip_number}: speed ×{sf:.3f} "
                  f"({natural_dur:.2f}s → {actual_dur:.2f}s)")

            # Speed-adjust the clip (and strip audio — narration is mixed later)
            adjusted_path = os.path.join(
                temp_dir, f"adjusted_{clip_number:03d}.mp4")
            speech_audio_path = None

            if abs(sf - 1.0) < 0.01:
                # No speed change — extract audio from ALL clips (matching SSAIVidGen.py)
                speech_audio_path = os.path.join(
                    temp_dir, f"speech_{clip_number:03d}.aac")
                try:
                    subprocess.run([
                        'ffmpeg', '-y', '-loglevel', 'error',
                        '-i', local_clip_path,
                        '-vn', '-c:a', 'aac', '-b:a', '128k',
                        '-ar', '44100', '-ac', '2',
                        '-t', f'{actual_dur:.6f}',
                        speech_audio_path
                    ], check=True, capture_output=True)
                    tag = "🗣️" if is_speech else "🔇"
                    print(
                        f"  {tag} Extracted audio for clip {clip_number}")
                except Exception as e:
                    # Clip has no audio track — create silent placeholder (matches SSAIVidGen.py)
                    try:
                        subprocess.run([
                            'ffmpeg', '-y', '-f', 'lavfi',
                            '-i', f'anullsrc=r=44100:cl=stereo',
                            '-t', f'{actual_dur:.6f}',
                            '-c:a', 'aac', '-b:a', '128k',
                            speech_audio_path
                        ], check=True, capture_output=True)
                        print(
                            f"  🔇 Created silent placeholder for clip {clip_number}")
                    except Exception as e2:
                        print(f"  ⚠️ Audio placeholder failed: {e2}")
                        speech_audio_path = None

                subprocess.run([
                    'ffmpeg', '-y', '-loglevel', 'error',
                    '-i', local_clip_path,
                    '-vf', 'scale=1920:1080,setpts=PTS-STARTPTS',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-r', '30',
                    '-an', adjusted_path
                ], check=True, capture_output=True)
            else:
                # Speed-adjust: extract audio with atempo for ALL clips (matching SSAIVidGen.py)
                speech_audio_path = os.path.join(
                    temp_dir, f"speech_{clip_number:03d}.aac")
                atempo = build_atempo_chain(sf)
                try:
                    subprocess.run([
                        'ffmpeg', '-y', '-loglevel', 'error',
                        '-i', local_clip_path,
                        '-vn', '-af', atempo,
                        '-c:a', 'aac', '-b:a', '128k',
                        '-ar', '44100', '-ac', '2',
                        '-t', f'{actual_dur:.6f}',
                        speech_audio_path
                    ], check=True, capture_output=True)
                    tag = "🗣️" if is_speech else "🔇"
                    print(
                        f"  {tag} Extracted speed-adjusted audio for clip {clip_number}")
                except Exception as e:
                    # Clip has no audio track — create silent placeholder (matches SSAIVidGen.py)
                    try:
                        subprocess.run([
                            'ffmpeg', '-y', '-f', 'lavfi',
                            '-i', f'anullsrc=r=44100:cl=stereo',
                            '-t', f'{actual_dur:.6f}',
                            '-c:a', 'aac', '-b:a', '128k',
                            speech_audio_path
                        ], check=True, capture_output=True)
                        print(
                            f"  🔇 Created silent placeholder for clip {clip_number}")
                    except Exception as e2:
                        print(f"  ⚠️ Audio placeholder failed: {e2}")
                        speech_audio_path = None

                speed_filter = f'scale=1920:1080,setpts=PTS/{sf:.6f}'
                subprocess.run([
                    'ffmpeg', '-y', '-loglevel', 'error',
                    '-i', local_clip_path,
                    '-vf', speed_filter,
                    '-t', f'{actual_dur:.6f}',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-r', '30',
                    '-an', adjusted_path
                ], check=True, capture_output=True)

            # Apply overlay if available
            final_clip_path = adjusted_path
            if overlay_available and overlay_path and effects_type and effects_type != 'none':
                overlay_transparency = overlay_configs.get(
                    effects_type, {}).get('transparency', 0.30)
                overlay_output = os.path.join(
                    temp_dir, f"overlay_{clip_number:03d}.mp4")

                if apply_overlay_to_video_clip(adjusted_path, overlay_path,
                                               overlay_output, actual_dur,
                                               overlay_transparency):
                    final_clip_path = overlay_output
                else:
                    print(
                        f"  ⚠️ Overlay failed for clip {clip_number}, using without overlay")

            # Upload to videos bucket (same path pattern as image mode)
            video_folder = f"videos/{user_id}/{group_id}/individual_videos"
            upload_path = f"{video_folder}/video_{clip_number}.mp4"

            if upload_video_to_supabase(supabase, final_clip_path, upload_path):
                print(f"  ✅ Uploaded video_{clip_number}.mp4 to videos bucket")

                # Upload speech audio if extracted
                speech_upload_path = None
                if speech_audio_path and os.path.exists(speech_audio_path):
                    speech_upload_path = f"{video_folder}/audio_{clip_number}.aac"
                    if upload_audio_to_supabase(supabase, speech_audio_path, speech_upload_path):
                        print(
                            f"  🔊 Uploaded audio_{clip_number}.aac to videos bucket")
                    else:
                        print(
                            f"  ⚠️ Speech audio upload failed for clip {clip_number}")
                        speech_upload_path = None

                return {
                    'success': True,
                    'clip_number': clip_number,
                    'image_number': clip_number,  # Compatibility with batch completion logic
                    'video_path': upload_path,
                    'speech_audio_path': speech_upload_path,
                    'has_speech': is_speech,
                    'duration': actual_dur
                }
            else:
                print(f"  ❌ Upload failed for clip {clip_number}")
                if retry_attempt == max_retries - 1:
                    return {'success': False, 'clip_number': clip_number, 'error': 'Upload failed'}

        except Exception as e:
            print(f"  ❌ Error processing clip {clip_number}: {str(e)}")
            if retry_attempt == max_retries - 1:
                return {'success': False, 'clip_number': clip_number, 'error': str(e)}

    return {'success': False, 'clip_number': clip_number, 'error': 'All retries failed'}


# STTDurationProcessor class removed - duration calculation now handled by calculate-video-durations.py GCloud function


def download_and_merge_audio_files(supabase_url, supabase_key, audio_path, temp_dir, model_version='v6'):
    """Download and merge audio files from folder or single file"""
    headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

    try:
        print(f"Attempting to download audio from path: {audio_path}")

        # Check if it's a single file first
        if audio_path.endswith(('.mp3', '.wav', '.m4a')):
            print(f"Detected single audio file: {audio_path}")
            extension = '.' + audio_path.split('.')[-1]
            single_audio_path = os.path.join(
                temp_dir, f"single_audio{extension}")

            audio_url = f"{supabase_url}/storage/v1/object/stories/{audio_path}"
            print(f"Downloading single audio file from: {audio_url}")

            if download_file(audio_url, single_audio_path, headers):
                print(f"Downloaded single audio file successfully")
                return single_audio_path
            else:
                print(f"Failed to download single audio file")
                return None

        # Original folder listing logic
        list_url = f"{supabase_url}/storage/v1/object/list/stories"
        list_response = requests.post(
            list_url,
            json={"prefix": audio_path, "limit": 1000},
            headers=headers
        )

        if list_response.status_code == 200:
            files = list_response.json()
            print(f"Found {len(files)} files in audio path")

            # Check for both .mp3 and .wav extensions dynamically
            audio_files = []
            detected_extension = None

            # Check for both extensions and use whichever is found
            for ext in ['.mp3', '.wav']:
                temp_audio_files = []
                for f in files:
                    if f.get("name") and f["name"].endswith(ext):
                        # Extract group number from filename (group_1.wav, group_2.wav, etc.)
                        filename = os.path.basename(f["name"])
                        match = re.match(r'group_(\d+)' +
                                         re.escape(ext), filename)
                        if match:
                            group_num = int(match.group(1))
                            # Construct the full path by combining audio_path with the filename
                            # The API returns relative paths, so we need to construct the full path
                            if f["name"] == filename:  # If API returned just filename
                                full_file_path = f"{audio_path}/{filename}"
                            else:  # If API returned full path
                                full_file_path = f["name"]

                            temp_audio_files.append(
                                (group_num, full_file_path))
                            print(
                                f"Found audio file: {filename} at constructed path: {full_file_path}")

                if temp_audio_files:
                    audio_files = temp_audio_files
                    detected_extension = ext
                    print(
                        f"Detected audio files with extension: {detected_extension}")
                    break

            if not detected_extension:
                print("No audio files found with .mp3 or .wav extensions")
                detected_extension = get_audio_file_extension(
                    model_version)  # Fallback
                print(
                    f"Falling back to model-based extension: {detected_extension}")

            if audio_files:
                # Sort by group number (natural sort)
                audio_files.sort(key=lambda x: x[0])
                print(f"Found {len(audio_files)} audio files to merge")

                # Download all audio files
                local_audio_files = []
                for group_num, file_path in audio_files:
                    local_filename = f"group_{group_num}{detected_extension}"
                    local_path = os.path.join(temp_dir, local_filename)
                    # Use the full file path for the URL
                    audio_url = f"{supabase_url}/storage/v1/object/stories/{file_path}"

                    print(f"Downloading {local_filename} from: {audio_url}")

                    if download_file(audio_url, local_path, headers):
                        local_audio_files.append(local_path)
                        print(f"Downloaded {local_filename}")
                    else:
                        print(f"Failed to download {local_filename}")
                        return None

                if not local_audio_files:
                    print("No audio files downloaded successfully")
                    return None

                # Merge audio files using ffmpeg
                merged_audio_path = os.path.join(
                    temp_dir, f"merged_audio{detected_extension}")

                if len(local_audio_files) == 1:
                    # Only one file, just copy it
                    import shutil
                    shutil.copy2(local_audio_files[0], merged_audio_path)
                    print("Single audio file copied as merged audio")
                else:
                    # Create file list for ffmpeg concat with natural sorting
                    # Sort the files naturally by extracting numbers
                    local_audio_files.sort(
                        key=lambda x: natural_sort_key(os.path.basename(x)))

                    file_list_path = os.path.join(temp_dir, "audio_list.txt")
                    with open(file_list_path, "w") as f:
                        for audio_file in local_audio_files:
                            f.write(f"file '{os.path.basename(audio_file)}'\n")

                    # Determine audio codec based on detected extension
                    if detected_extension == '.wav':
                        audio_codec = ['-c:a', 'pcm_s16le',
                                       '-ar', '44100', '-ac', '2']
                    elif detected_extension == '.mp3':
                        audio_codec = ['-c:a', 'mp3', '-b:a', '128k']
                    else:
                        audio_codec = ['-c:a', 'aac', '-b:a', '128k']

                    try:
                        cmd = [
                            'ffmpeg', "-y", "-f", "concat", "-safe", "0", "-i", file_list_path
                        ] + audio_codec + ["-avoid_negative_ts", "make_zero", merged_audio_path]

                        subprocess.run(
                            cmd, check=True, capture_output=True, cwd=temp_dir)
                        print("Audio files merged successfully")
                    except subprocess.CalledProcessError as e:
                        print(f"FFmpeg audio merge error: {e.stderr.decode()}")
                        return None

                return merged_audio_path

        # If listing failed or no grouped files found, try as single file
        print("No grouped audio files found, trying to download as single audio file")

        # Try both extensions for single files
        for ext in ['.mp3', '.wav']:
            single_audio_path = os.path.join(temp_dir, f"single_audio{ext}")

            # Try different possible single file paths
            possible_paths = [
                audio_path,  # Direct path (if it's a file)
                f"{audio_path}/merged{ext}",  # merged.wav/merged.mp3 in folder
                # merged.wav/merged.mp3 appended to folder path
                f"{audio_path}merged{ext}",
            ]

            for path in possible_paths:
                audio_url = f"{supabase_url}/storage/v1/object/stories/{path}"
                print(
                    f"Trying to download single audio file from: {audio_url}")
                if download_file(audio_url, single_audio_path, headers):
                    print(f"Downloaded single audio file from {path}")
                    return single_audio_path

        print("Failed to download any audio files")
        return None

    except Exception as e:
        print(f"Error downloading audio files: {str(e)}")
        return None


def parse_image_prompt_document(content):
    """Parse the image prompt document to extract text segments and durations"""
    blocks = re.findall(r'\[(.*?)\]', content, re.DOTALL)
    text_segments = []
    image_prompts = []

    for i in range(0, len(blocks), 2):
        try:
            text = blocks[i].strip()
            prompt = blocks[i+1].strip() if i+1 < len(blocks) else ""
            text_segments.append(text)
            image_prompts.append(prompt)
        except IndexError:
            pass

    return text_segments, image_prompts


def count_words(s):
    """Count words in a string"""
    return len(re.split(r'\s+', s.strip()))


def get_proportional_durations(text_segments, total_duration):
    """Calculate proportional durations based on word count"""
    total_words = sum(count_words(s) for s in text_segments)
    if total_words == 0:
        return [5] * len(text_segments)  # Return integers
    return [max(1, round((count_words(s) / total_words) * total_duration)) for s in text_segments]


def remux_and_get_duration_ffmpeg(file_path):
    """Remux MP3 file to fix corrupted structure, then get accurate duration"""
    try:
        # Create remuxed file path
        remuxed_path = file_path.rsplit('.', 1)[0] + '_remuxed.mp3'

        print(f"Remuxing file to fix structure: {file_path}")

        # Remux: copy audio stream without re-encoding, strip bad metadata
        remux_cmd = [
            'ffmpeg',
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
            'ffprobe',
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
        cmd = [
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
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


# get_segment_durations_using_enhanced_stt_temp_files removed - now handled by calculate-video-durations.py
# calculate_and_store_durations removed - now handled by calculate-video-durations.py


def verify_video_file(video_path):
    """Verify that a video file is valid and not corrupted"""
    try:
        # Check if file exists and has size > 0
        if not os.path.exists(video_path):
            print(f"❌ Video file does not exist: {video_path}")
            return False

        file_size = os.path.getsize(video_path)
        if file_size == 0:
            print(f"❌ Video file is empty: {video_path}")
            return False

        if file_size < 1024:  # Less than 1KB is suspicious
            print(
                f"⚠️ Video file is very small ({file_size} bytes): {video_path}")
            return False

        # Use ffprobe to verify video integrity
        cmd = [
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,duration',
            '-of', 'csv=p=0', video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            print(f"❌ FFprobe failed for video: {video_path}")
            print(f"Error: {result.stderr}")
            return False

        # Parse ffprobe output
        output_lines = result.stdout.strip().split('\n')
        if not output_lines or not output_lines[0]:
            print(f"❌ No video stream found in: {video_path}")
            return False

        codec_duration = output_lines[0].split(',')
        if len(codec_duration) != 2:
            print(f"❌ Invalid ffprobe output for: {video_path}")
            return False

        codec, duration_str = codec_duration
        try:
            duration = float(duration_str)
            if duration <= 0:
                print(f"❌ Video has zero duration: {video_path}")
                return False
        except ValueError:
            print(f"❌ Invalid duration in video: {video_path}")
            return False

        print(
            f"✅ Video file verified: {video_path} ({file_size} bytes, {duration:.2f}s, {codec})")
        return True

    except Exception as e:
        print(f"❌ Error verifying video file {video_path}: {str(e)}")
        return False


def get_video_duration(video_path):
    """Get the duration of a video file in seconds."""
    cmd = [
        'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', video_path
    ]

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, check=True)
        return float(result.stdout.strip())
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to get duration for {video_path}: {e}")
        return None


def create_overlay_copy(original_path, copy_number, temp_folder):
    """Create a copy of the overlay video."""
    overlay_name = os.path.splitext(os.path.basename(original_path))[0]
    copy_path = os.path.join(
        temp_folder, f"{overlay_name}_copy_{copy_number}.mp4")

    cmd = [
        'ffmpeg', '-y', '-i', original_path,
        '-c', 'copy',  # Just copy without re-encoding
        copy_path
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(
            f"   📋 Created copy {copy_number}: {os.path.basename(copy_path)}")
        return copy_path
    except subprocess.CalledProcessError as e:
        print(
            f"   ❌ Failed to create copy {copy_number}: {e.stderr.decode() if e.stderr else 'Unknown error'}")
        return None


def combine_overlay_videos(video_paths, output_path, target_duration):
    """Combine multiple overlay videos into one long video."""
    # Create concat file
    concat_file = os.path.join(os.path.dirname(output_path), 'concat_list.txt')

    with open(concat_file, 'w') as f:
        for video_path in video_paths:
            f.write(f"file '{os.path.abspath(video_path)}'\n")

    print(f"   🔗 Combining {len(video_paths)} overlay videos into one...")

    cmd = [
        'ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_file,
        '-t', str(target_duration),  # Trim to exact target duration
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        output_path
    ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(
            f"   ✅ Combined overlay created: {os.path.basename(output_path)}")

        # Clean up concat file
        os.remove(concat_file)

        # Verify the created file duration
        created_duration = get_video_duration(output_path)
        if created_duration:
            print(f"   ✓ Combined overlay duration: {created_duration:.1f}s")

        return True
    except subprocess.CalledProcessError as e:
        print(
            f"   ❌ Failed to combine overlay videos: {e.stderr.decode() if e.stderr else 'Unknown error'}")
        if os.path.exists(concat_file):
            os.remove(concat_file)
        return False


def create_extended_overlay(overlay_path, target_duration, temp_folder):
    """Create an extended overlay by creating copies and combining them."""
    overlay_duration = get_video_duration(overlay_path)
    if overlay_duration is None:
        return None

    # Calculate how many copies we need
    copies_needed = math.ceil(target_duration / overlay_duration)

    if copies_needed <= 1:
        # No extension needed
        return overlay_path

    print(
        f"   📏 Overlay duration: {overlay_duration:.1f}s, Target: {target_duration}s")
    print(f"   🔄 Need {copies_needed} copies of the overlay")

    overlay_name = os.path.splitext(os.path.basename(overlay_path))[0]

    # Step 1: Create copies
    print(f"   📋 Step 1: Creating {copies_needed-1} copies...")
    video_paths = [overlay_path]  # Start with original
    copy_paths = []

    for i in range(1, copies_needed):  # Start from 1 since we already have the original
        copy_path = create_overlay_copy(overlay_path, i, temp_folder)
        if copy_path is None:
            # Clean up any copies created so far
            for cp in copy_paths:
                if os.path.exists(cp):
                    os.remove(cp)
            return None
        copy_paths.append(copy_path)
        video_paths.append(copy_path)

    # Step 2: Combine all videos
    print(f"   🔗 Step 2: Combining {len(video_paths)} videos...")
    combined_overlay_path = os.path.join(
        temp_folder, f"{overlay_name}_combined_{target_duration}s.mp4")

    success = combine_overlay_videos(
        video_paths, combined_overlay_path, target_duration)

    # Step 3: Clean up copies
    print(f"   🗑️ Step 3: Cleaning up {len(copy_paths)} temporary copies...")
    for copy_path in copy_paths:
        if os.path.exists(copy_path):
            os.remove(copy_path)
            print(f"   🗑️ Deleted: {os.path.basename(copy_path)}")

    if success:
        return combined_overlay_path
    else:
        # Clean up combined file if creation failed
        if os.path.exists(combined_overlay_path):
            os.remove(combined_overlay_path)
        return None


def cleanup_extended_overlays(temp_folder):
    """Clean up temporary extended overlay files"""
    if os.path.exists(temp_folder):
        for file in os.listdir(temp_folder):
            if file.endswith('.mp4'):
                os.remove(os.path.join(temp_folder, file))
                print(f"🗑️ Deleted: {file}")
        try:
            os.rmdir(temp_folder)
            print(f"🗑️ Removed temporary folder")
        except OSError:
            pass


def calculate_video_segments(duration):
    """Calculate how many L→R and R→L segments needed"""
    cycle_duration = 20.0
    segments = []
    remaining = duration
    direction = "left_to_right"  # Always start left to right

    while remaining > 0:
        segment_duration = min(cycle_duration, remaining)
        segments.append({
            'direction': direction,
            'duration': segment_duration
        })
        remaining -= segment_duration
        # Alternate direction
        direction = "right_to_left" if direction == "left_to_right" else "left_to_right"

    return segments


def calculate_vertical_video_segments(duration):
    """Calculate how many Top→Bottom and Bottom→Top segments needed"""
    cycle_duration = 20.0
    segments = []
    remaining = duration
    direction = "top_to_bottom"  # Always start top to bottom

    while remaining > 0:
        segment_duration = min(cycle_duration, remaining)
        segments.append({
            'direction': direction,
            'duration': segment_duration
        })
        remaining -= segment_duration
        # Alternate direction
        direction = "bottom_to_top" if direction == "top_to_bottom" else "top_to_bottom"

    return segments


def create_directional_video_crop(image_path, direction, duration, fps, target_width, target_height, overlay_path=None, overlay_transparency=0.3, output_path=None):
    """Create single direction video using the CROP method (scale + crop filters)"""
    # Create temp folder for extended overlays if overlay is used
    temp_folder = None
    extended_overlay_created = False
    final_overlay_path = overlay_path

    if overlay_path:
        temp_folder = os.path.join(
            os.path.dirname(output_path), 'temp_overlays')
        os.makedirs(temp_folder, exist_ok=True)

        # Check if overlay needs extension
        overlay_duration = get_video_duration(overlay_path)
        if overlay_duration and duration > overlay_duration:
            print(
                f"   ⚠️ Video duration ({duration}s) longer than overlay ({overlay_duration:.1f}s)")
            print(f"   🔧 Creating extended overlay...")
            extended_overlay = create_extended_overlay(
                overlay_path, duration, temp_folder)
            if extended_overlay:
                final_overlay_path = extended_overlay
                extended_overlay_created = True
            else:
                print(
                    f"   ❌ Failed to create extended overlay, proceeding without overlay")
                final_overlay_path = None

    # Get image dimensions to calculate proper scaling
    try:
        from PIL import Image
        with Image.open(image_path) as img:
            img_width, img_height = img.size
    except ImportError:
        # Fallback if PIL not available
        img_width, img_height = 1920, 1080

    # Scale image to be larger than video frame for panning room
    scale_factor = max(target_width / img_width,
                       target_height / img_height) * 1.25
    scaled_width = int(img_width * scale_factor)
    scaled_height = int(img_height * scale_factor)

    # Maximum crop position (for panning)
    max_crop_x = scaled_width - target_width

    print(f"🎬 Creating {direction} video using CROP method:")
    print(f"   Original: {img_width}x{img_height}")
    print(f"   Scaled: {scaled_width}x{scaled_height}")
    print(f"   Max crop: {max_crop_x}px")
    print(f"   Duration: {duration:.2f}s")

    # Calculate crop position based on direction
    if direction == "left_to_right":
        # Start from left (crop_x=0), move to right (crop_x=max_crop_x)
        crop_x_formula = f"{max_crop_x}*t/{20}"
    else:  # right_to_left
        # Start from right (crop_x=max_crop_x), move to left (crop_x=0)
        crop_x_formula = f"{max_crop_x}*(1-t/{20})"

    # Build ffmpeg command
    cmd = ['ffmpeg', '-y', '-loglevel',
           'error', '-loop', '1', '-i', image_path]

    # Add overlay input if exists
    apply_overlay = final_overlay_path is not None
    if apply_overlay:
        cmd.extend(['-i', final_overlay_path])

    # Build filter using scale + crop method
    base_filter = f"scale={scaled_width}:{scaled_height},crop={target_width}:{target_height}:{crop_x_formula}:0"

    if apply_overlay:
        # Apply crop to base image, then overlay with transparency
        filter_complex = (
            f"[0:v]{base_filter}[base];"
            f"[1:v]scale={target_width}:{target_height},format=yuva420p,colorchannelmixer=aa={overlay_transparency}[ovr];"
            f"[base][ovr]overlay=0:0"
        )
        cmd.extend(['-filter_complex', filter_complex])
    else:
        # No overlay, just apply crop animation
        cmd.extend(['-vf', base_filter])

    # Optimized settings
    cmd.extend([
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-t', str(duration), '-pix_fmt', 'yuv420p', '-r', str(fps),
        '-movflags', '+faststart', output_path
    ])

    try:
        result = subprocess.run(
            cmd, check=True, capture_output=True, text=True)
        print(f"✅ Created {direction} video: {output_path} ({duration:.2f}s)")

        # Clean up extended overlay if it was created
        if extended_overlay_created and os.path.exists(final_overlay_path):
            print(f"   🗑️ Step 4: Cleaning up extended overlay...")
            os.remove(final_overlay_path)
            print(f"   🗑️ Deleted: {os.path.basename(final_overlay_path)}")

        # Remove temp folder if empty and exists
        if temp_folder and os.path.exists(temp_folder):
            try:
                os.rmdir(temp_folder)
            except OSError:
                pass

        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to create {direction} video: {e.stderr}")

        # Clean up on failure
        if extended_overlay_created and final_overlay_path and os.path.exists(final_overlay_path):
            os.remove(final_overlay_path)
        if temp_folder and os.path.exists(temp_folder):
            try:
                os.rmdir(temp_folder)
            except OSError:
                pass

        return False


def create_vertical_directional_video_crop(image_path, direction, duration, fps, target_width, target_height, overlay_path=None, overlay_transparency=0.3, output_path=None):
    """Create single direction vertical video using the CROP method (scale + crop filters)"""
    # Create temp folder for extended overlays if overlay is used
    temp_folder = None
    extended_overlay_created = False
    final_overlay_path = overlay_path

    if overlay_path:
        temp_folder = os.path.join(
            os.path.dirname(output_path), 'temp_overlays')
        os.makedirs(temp_folder, exist_ok=True)

        # Check if overlay needs extension
        overlay_duration = get_video_duration(overlay_path)
        if overlay_duration and duration > overlay_duration:
            print(
                f"   ⚠️ Video duration ({duration}s) longer than overlay ({overlay_duration:.1f}s)")
            print(f"   🔧 Creating extended overlay...")
            extended_overlay = create_extended_overlay(
                overlay_path, duration, temp_folder)
            if extended_overlay:
                final_overlay_path = extended_overlay
                extended_overlay_created = True
            else:
                print(
                    f"   ❌ Failed to create extended overlay, proceeding without overlay")
                final_overlay_path = None

    # Get image dimensions to calculate proper scaling
    try:
        from PIL import Image
        with Image.open(image_path) as img:
            img_width, img_height = img.size
    except ImportError:
        # Fallback if PIL not available
        img_width, img_height = 1920, 1080

    # Scale image to be larger than video frame for vertical panning room
    # Increased for more vertical room
    scale_factor = max(target_width / img_width,
                       target_height / img_height) * 1.3
    scaled_width = int(img_width * scale_factor)
    scaled_height = int(img_height * scale_factor)

    # Maximum crop position (for vertical panning)
    max_crop_y = scaled_height - target_height

    print(f"🎬 Creating {direction} vertical video using CROP method:")
    print(f"   Original: {img_width}x{img_height}")
    print(f"   Scaled: {scaled_width}x{scaled_height}")
    print(f"   Max crop Y: {max_crop_y}px")
    print(f"   Duration: {duration:.2f}s")

    # Calculate crop position based on direction
    # Keep horizontally centered
    crop_x_formula = f"({scaled_width}-{target_width})/2"
    if direction == "top_to_bottom":
        # Start from top (crop_y=0), move to bottom (crop_y=max_crop_y)
        crop_y_formula = f"{max_crop_y}*t/{20}"
    else:  # bottom_to_top
        # Start from bottom (crop_y=max_crop_y), move to top (crop_y=0)
        crop_y_formula = f"{max_crop_y}*(1-t/{20})"

    # Build ffmpeg command
    cmd = ['ffmpeg', '-y', '-loglevel',
           'error', '-loop', '1', '-i', image_path]

    # Add overlay input if exists
    apply_overlay = final_overlay_path is not None
    if apply_overlay:
        cmd.extend(['-i', final_overlay_path])

    # Build filter using scale + crop method for vertical movement
    base_filter = f"scale={scaled_width}:{scaled_height},crop={target_width}:{target_height}:{crop_x_formula}:{crop_y_formula}"

    if apply_overlay:
        # Apply crop to base image, then overlay with transparency
        filter_complex = (
            f"[0:v]{base_filter}[base];"
            f"[1:v]scale={target_width}:{target_height},format=yuva420p,colorchannelmixer=aa={overlay_transparency}[ovr];"
            f"[base][ovr]overlay=0:0"
        )
        cmd.extend(['-filter_complex', filter_complex])
    else:
        # No overlay, just apply crop animation
        cmd.extend(['-vf', base_filter])

    # Optimized settings
    cmd.extend([
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-t', str(duration), '-pix_fmt', 'yuv420p', '-r', str(fps),
        '-movflags', '+faststart', output_path
    ])

    try:
        result = subprocess.run(
            cmd, check=True, capture_output=True, text=True)
        print(
            f"✅ Created {direction} vertical video: {output_path} ({duration:.2f}s)")

        # Clean up extended overlay if it was created
        if extended_overlay_created and os.path.exists(final_overlay_path):
            print(f"   🗑️ Step 4: Cleaning up extended overlay...")
            os.remove(final_overlay_path)
            print(f"   🗑️ Deleted: {os.path.basename(final_overlay_path)}")

        # Remove temp folder if empty and exists
        if temp_folder and os.path.exists(temp_folder):
            try:
                os.rmdir(temp_folder)
            except OSError:
                pass

        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to create {direction} vertical video: {e.stderr}")

        # Clean up on failure
        if extended_overlay_created and final_overlay_path and os.path.exists(final_overlay_path):
            os.remove(final_overlay_path)
        if temp_folder and os.path.exists(temp_folder):
            try:
                os.rmdir(temp_folder)
            except OSError:
                pass

        return False


def concatenate_videos(temp_videos, output_path):
    """Concatenate multiple videos using FFmpeg concat filter"""
    if len(temp_videos) == 1:
        # Just copy the single video
        cmd = ['ffmpeg', '-y', '-i', temp_videos[0], '-c', 'copy', output_path]
    else:
        # Use concat filter for multiple videos
        input_args = []
        for video in temp_videos:
            input_args.extend(['-i', video])

        video_inputs = ''.join(f'[{i}:v]' for i in range(len(temp_videos)))
        filter_complex_str = f"{video_inputs}concat=n={len(temp_videos)}:v=1:a=0[v]"

        cmd = ['ffmpeg', '-y'] + input_args + [
            '-filter_complex', filter_complex_str,
            '-map', '[v]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output_path
        ]

    try:
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"✅ Concatenated video created: {output_path}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Concatenation failed: {e.stderr.decode()}")
        return False


def create_smooth_drift_video_crop(image_path, duration, fps, target_width, target_height, overlay_path=None, overlay_transparency=0.3, output_path=None):
    """Create smooth back-and-forth drift video using CROP method by combining directional segments"""
    segments = calculate_video_segments(duration)

    if len(segments) == 1:
        # Single video - just create it directly using crop method
        return create_directional_video_crop(
            image_path, segments[0]['direction'], segments[0]['duration'],
            fps, target_width, target_height, overlay_path, overlay_transparency, output_path
        )
    else:
        # Multiple segments - create each then concatenate
        temp_videos = []
        base_name = os.path.splitext(output_path)[0]

        for i, segment in enumerate(segments):
            temp_path = f"{base_name}_segment_{i}.mp4"
            success = create_directional_video_crop(
                image_path, segment['direction'], segment['duration'],
                fps, target_width, target_height, overlay_path, overlay_transparency, temp_path
            )
            if success:
                temp_videos.append(temp_path)
            else:
                # Clean up any created temp files and return failure
                for temp_video in temp_videos:
                    try:
                        os.remove(temp_video)
                    except OSError:
                        pass
                return False

        # Concatenate all segments
        success = concatenate_videos(temp_videos, output_path)

        # Clean up temp videos after concatenation
        for temp_video in temp_videos:
            try:
                os.remove(temp_video)
                print(f"🗑️ Deleted temp video: {temp_video}")
            except OSError:
                pass

        return success


def create_smooth_vertical_drift_video_crop(image_path, duration, fps, target_width, target_height, overlay_path=None, overlay_transparency=0.3, output_path=None):
    """Create smooth back-and-forth vertical drift video using CROP method by combining directional segments"""
    segments = calculate_vertical_video_segments(duration)

    if len(segments) == 1:
        # Single video - just create it directly using vertical crop method
        return create_vertical_directional_video_crop(
            image_path, segments[0]['direction'], segments[0]['duration'],
            fps, target_width, target_height, overlay_path, overlay_transparency, output_path
        )
    else:
        # Multiple segments - create each then concatenate
        temp_videos = []
        base_name = os.path.splitext(output_path)[0]

        for i, segment in enumerate(segments):
            temp_path = f"{base_name}_segment_{i}.mp4"
            success = create_vertical_directional_video_crop(
                image_path, segment['direction'], segment['duration'],
                fps, target_width, target_height, overlay_path, overlay_transparency, temp_path
            )
            if success:
                temp_videos.append(temp_path)
            else:
                # Clean up any created temp files and return failure
                for temp_video in temp_videos:
                    try:
                        os.remove(temp_video)
                    except OSError:
                        pass
                return False

        # Concatenate all segments
        success = concatenate_videos(temp_videos, output_path)

        # Clean up temp videos after concatenation
        for temp_video in temp_videos:
            try:
                os.remove(temp_video)
                print(f"🗑️ Deleted temp video: {temp_video}")
            except OSError:
                pass

        return success


# ──────────────────────────────────────────────────────────────────────────────
# Ken Burns animation (supersampled zoompan, smooth zoom in / zoom out cycles).
# Ported from SSAIVidGen2.py.
# ──────────────────────────────────────────────────────────────────────────────

KEN_BURNS_CYCLE_DURATION = 12.0  # seconds per zoom_in / zoom_out segment
KEN_BURNS_SUPERSAMPLE = 1.5      # render zoompan at 1.5x target then bilinear-down
KEN_BURNS_ZOOM_START = 1.0
KEN_BURNS_ZOOM_MAX = 1.25


def calculate_ken_burns_video_segments(duration):
    """Split a duration into alternating zoom_in / zoom_out segments of up to 12s."""
    segments = []
    remaining = duration
    direction = "zoom_in"  # always start zoomed in
    while remaining > 0:
        seg_dur = min(KEN_BURNS_CYCLE_DURATION, remaining)
        segments.append({'direction': direction, 'duration': seg_dur})
        remaining -= seg_dur
        direction = "zoom_out" if direction == "zoom_in" else "zoom_in"
    return segments


def create_ken_burns_directional_video_crop(image_path, direction, duration, fps,
                                            target_width, target_height,
                                            overlay_path=None, overlay_transparency=0.3,
                                            output_path=None):
    """Create a single-direction Ken Burns clip using supersampled zoompan.

    The standard zoompan filter rounds its zoom region to integer pixels each
    frame, producing visible 1-px shake. Rendering at 1.3x the target then
    bilinear-downscaling spreads the sub-pixel movement smoothly, hiding the
    jitter while keeping render time close to the simple drift implementation.
    """
    big_w = (int(target_width * KEN_BURNS_SUPERSAMPLE) // 2) * 2  # even
    big_h = (int(target_height * KEN_BURNS_SUPERSAMPLE) // 2) * 2

    frames = max(1, int(duration * fps))
    denom = max(frames - 1, 1)

    # Match drift's apparent zoom speed: a 12s segment covers the full
    # KEN_BURNS_ZOOM_START -> KEN_BURNS_ZOOM_MAX range; shorter segments
    # cover a proportional fraction so motion stays consistent across cuts.
    duration_fraction = min(duration / KEN_BURNS_CYCLE_DURATION, 1.0)
    zoom_range = (KEN_BURNS_ZOOM_MAX - KEN_BURNS_ZOOM_START) * \
        duration_fraction
    zoom_end_actual = KEN_BURNS_ZOOM_START + zoom_range

    if direction == "zoom_in":
        zoom_expr = f"{KEN_BURNS_ZOOM_START}+{zoom_range}*(on-1)/{denom}"
    else:  # zoom_out
        zoom_expr = f"{zoom_end_actual}-{zoom_range}*(on-1)/{denom}"

    # Pure Ken Burns: centre the zoom region (no pan).
    x_expr = "iw/2-(iw/zoom/2)"
    y_expr = "ih/2-(ih/zoom/2)"

    base_filter = (
        f"zoompan=z='{zoom_expr}':"
        f"x='{x_expr}':y='{y_expr}':"
        f"d={frames}:fps={fps}:s={big_w}x{big_h},"
        f"scale={target_width}:{target_height}:flags=bilinear"
    )

    cmd = ['ffmpeg', '-y', '-loglevel',
           'error', '-loop', '1', '-i', image_path]
    apply_overlay = overlay_path is not None
    if apply_overlay:
        cmd.extend(['-i', overlay_path])
        filter_complex = (
            f"[0:v]{base_filter}[base];"
            f"[1:v]scale={target_width}:{target_height},format=yuva420p,"
            f"colorchannelmixer=aa={overlay_transparency}[ovr];"
            f"[base][ovr]overlay=0:0"
        )
        cmd.extend(['-filter_complex', filter_complex])
    else:
        cmd.extend(['-vf', base_filter])

    cmd.extend([
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-t', str(duration), '-pix_fmt', 'yuv420p', '-r', str(fps),
        '-movflags', '+faststart', '-an', output_path,
    ])

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        print(
            f"✅ Created {direction} Ken Burns video: {output_path} ({duration:.2f}s)")
        return True
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed Ken Burns video ({direction}): {e.stderr}")
        return False


def create_smooth_ken_burns_video_crop(image_path, duration, fps, target_width, target_height,
                                       overlay_path=None, overlay_transparency=0.3,
                                       output_path=None):
    """Create a smooth back-and-forth Ken Burns video by combining 12s zoom segments."""
    segments = calculate_ken_burns_video_segments(duration)

    if len(segments) == 1:
        return create_ken_burns_directional_video_crop(
            image_path, segments[0]['direction'], segments[0]['duration'],
            fps, target_width, target_height,
            overlay_path, overlay_transparency, output_path,
        )

    temp_videos = []
    base_name = os.path.splitext(output_path)[0]
    for i, segment in enumerate(segments):
        temp_path = f"{base_name}_kb_segment_{i}.mp4"
        ok = create_ken_burns_directional_video_crop(
            image_path, segment['direction'], segment['duration'],
            fps, target_width, target_height,
            overlay_path, overlay_transparency, temp_path,
        )
        if not ok:
            for tv in temp_videos:
                try:
                    os.remove(tv)
                except OSError:
                    pass
            return False
        temp_videos.append(temp_path)

    success = concatenate_videos(temp_videos, output_path)
    for tv in temp_videos:
        try:
            os.remove(tv)
        except OSError:
            pass
    return success


def create_video_from_image_with_overlay(image_path, overlay_path, output_path, duration=5.0, animation_type='drift'):
    """Create a video from image with overlay and optional drift effect - NO AUDIO"""
    max_retries = 2

    for attempt in range(max_retries):
        try:
            print(
                f"🎬 Creating video with overlay (attempt {attempt + 1}/{max_retries})")

            # Target resolution
            target_width = 1920
            target_height = 1080
            resolution = f'{target_width}x{target_height}'

            # Base filter for scaling and cropping
            base_filter = f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase,crop={target_width}:{target_height}"

            # Apply animation if specified
            if animation_type == 'drift':
                # Calculate movement speed based on duration
                movement_per_frame = max(0.01, min(2.0, 5.0 / duration))
                zoom_factor = 1.25

                # Enhanced smooth drift filter
                drift_filter = f"{base_filter},zoompan=z='{zoom_factor}':x='if(eq(on,1),0,x+{movement_per_frame})':y='ih/2-(ih/zoom)/2':d={int(duration*60)}:s={resolution}:fps=60"
            else:
                # No animation - static image
                drift_filter = f"{base_filter},loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS"

            cmd = [
                'ffmpeg', "-y", "-loglevel", "error", "-loop", "1", "-i", image_path,
                "-i", overlay_path,
                "-filter_complex",
                f"[0:v]{drift_filter}[base];[1:v]scale={target_width}:{target_height},format=yuva420p,colorchannelmixer=aa=0.3[ovr];[base][ovr]overlay=0:0",
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-t", str(duration), "-pix_fmt", "yuv420p", "-r", "60",
                "-movflags", "+faststart",
                "-an",  # Explicitly disable audio
                output_path
            ]

            print(
                f"🔧 FFmpeg command: {' '.join(cmd[:8])}... (duration: {duration}s)")
            result = subprocess.run(
                cmd, check=True, capture_output=True, text=True)

            # Verify the created video
            if verify_video_file(output_path):
                print(f"✅ Video created successfully with overlay")
                return True
            else:
                print(f"❌ Video verification failed on attempt {attempt + 1}")
                if attempt < max_retries - 1:
                    # Clean up failed file and retry
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    continue
                else:
                    return False

        except subprocess.CalledProcessError as e:
            print(f"❌ FFmpeg error on attempt {attempt + 1}: {e.stderr}")
            if attempt < max_retries - 1:
                # Clean up failed file and retry
                if os.path.exists(output_path):
                    os.remove(output_path)
                time.sleep(2)  # Wait before retry
                continue
            else:
                return False
        except Exception as e:
            print(
                f"❌ Error creating video with overlay on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                if os.path.exists(output_path):
                    os.remove(output_path)
                time.sleep(2)
                continue
            else:
                return False

    return False


def create_video_from_image_no_overlay(image_path, output_path, duration=5.0, animation_type='drift'):
    """Create a video from image without overlay using segmented approach for drift and vertical"""
    max_retries = 2

    for attempt in range(max_retries):
        try:
            print(
                f"🎬 Creating video without overlay (attempt {attempt + 1}/{max_retries})")

            target_width = 1920
            target_height = 1080

            if animation_type == 'drift':
                # Use horizontal drift approach from Python file
                success = create_smooth_drift_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    None, 0.3, output_path
                )
            elif animation_type == 'vertical':
                # Use vertical drift approach from Python file
                success = create_smooth_vertical_drift_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    None, 0.3, output_path
                )
            elif animation_type == 'ken_burns':
                # Ken Burns: smooth zoom_in/zoom_out cycles via supersampled zoompan
                success = create_smooth_ken_burns_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    None, 0.3, output_path
                )
            else:
                # Static animation - keep existing logic
                base_filter = f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase,crop={target_width}:{target_height}"
                drift_filter = f"{base_filter},loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS"

                cmd = [
                    'ffmpeg', "-y", "-loglevel", "error", "-loop", "1", "-i", image_path,
                    "-vf", drift_filter,
                    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-t", str(duration), "-pix_fmt", "yuv420p", "-r", "60",
                    "-movflags", "+faststart", "-an", output_path
                ]

                result = subprocess.run(
                    cmd, check=True, capture_output=True, text=True)
                success = True

            if success and verify_video_file(output_path):
                print(f"✅ Video created successfully without overlay")
                return True
            else:
                print(f"❌ Video verification failed on attempt {attempt + 1}")
                if attempt < max_retries - 1:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    continue
                else:
                    return False

        except Exception as e:
            print(
                f"❌ Error creating video from image on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                if os.path.exists(output_path):
                    os.remove(output_path)
                time.sleep(2)
                continue
            else:
                return False

    return False


def verify_video_exists_in_storage(supabase_url, supabase_key, video_path):
    """Verify that a video file exists in Supabase storage"""
    try:
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # Try to get file info from storage
        info_url = f"{supabase_url}/storage/v1/object/info/videos/{video_path}"
        response = requests.get(info_url, headers=headers)

        if response.status_code == 200:
            print(f"✅ Verified video exists in storage: {video_path}")
            return True
        else:
            print(
                f"❌ Video not found in storage: {video_path} (Status: {response.status_code})")
            return False

    except Exception as e:
        print(f"❌ Error verifying video in storage {video_path}: {str(e)}")
        return False


def upload_audio_to_supabase(supabase, audio_path, upload_path):
    """Upload audio file (.aac) to Supabase storage — skips video verification."""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            supabase_url = os.getenv("SUPABASE_URL")
            supabase_key = os.getenv("SUPABASE_SECRET_KEY")
            upload_url = f"{supabase_url}/storage/v1/object/videos/{upload_path}"
            headers = {
                "Authorization": f"Bearer {supabase_key}",
                "apikey": supabase_key,
                "Content-Type": "audio/aac",
                "x-upsert": "true"
            }
            if not os.path.exists(audio_path) or os.path.getsize(audio_path) == 0:
                print(f"❌ Audio file missing or empty: {audio_path}")
                return False
            with open(audio_path, "rb") as f:
                response = requests.post(
                    upload_url, data=f, headers=headers)
                response.raise_for_status()
            print(f"✅ Audio upload successful for {upload_path}")
            return True
        except Exception as e:
            print(f"⚠️ Audio upload attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(3)
    return False


def upload_video_to_supabase(supabase, video_path, upload_path):
    """Upload video to Supabase storage with retry logic"""
    max_retries = 3

    for attempt in range(max_retries):
        try:
            print(
                f"📤 Uploading video (attempt {attempt + 1}/{max_retries}): {upload_path}")

            supabase_url = os.getenv("SUPABASE_URL")
            supabase_key = os.getenv("SUPABASE_SECRET_KEY")

            upload_url = f"{supabase_url}/storage/v1/object/videos/{upload_path}"
            headers = {
                "Authorization": f"Bearer {supabase_key}",
                "apikey": supabase_key,
                "Content-Type": "video/mp4",
                # Overwrite if file already exists (prevents 409 on retries)
                "x-upsert": "true"
            }

            # Verify local file before upload
            if not verify_video_file(video_path):
                print(f"❌ Local video file verification failed: {video_path}")
                return False

            with open(video_path, "rb") as f:
                response = requests.post(
                    upload_url,
                    data=f,
                    headers=headers,
                )
                response.raise_for_status()

            print(f"✅ Upload successful for {upload_path}")

            # Verify the upload worked by checking if file exists in storage
            time.sleep(1)  # Brief wait for storage consistency
            if verify_video_exists_in_storage(supabase_url, supabase_key, upload_path):
                return True
            else:
                print(
                    f"⚠️ Upload appeared successful but verification failed on attempt {attempt + 1}")
                if attempt < max_retries - 1:
                    time.sleep(5)  # Wait before retry
                    continue
                else:
                    return False

        except requests.exceptions.Timeout:
            print(f"⏰ Upload timeout on attempt {attempt + 1}")
            if attempt < max_retries - 1:
                time.sleep(10)  # Wait longer after timeout
                continue
            else:
                return False
        except requests.exceptions.RequestException as e:
            print(f"📤 Upload request error on attempt {attempt + 1}: {str(e)}")
            if hasattr(e, 'response') and e.response is not None:
                print(f"Response status: {e.response.status_code}")
                print(f"Response text: {e.response.text[:500]}")
            if attempt < max_retries - 1:
                time.sleep(5)
                continue
            else:
                return False
        except Exception as e:
            print(f"❌ Upload error on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(5)
                continue
            else:
                return False

    return False


def create_video_from_image_with_overlay_and_transparency(image_path, overlay_path, output_path, duration=5.0, animation_type='drift', transparency=0.30):
    """Create a video from image with overlay using segmented approach for drift and vertical"""
    max_retries = 2

    for attempt in range(max_retries):
        try:
            print(
                f"🎬 Creating video with overlay (transparency: {transparency}, attempt {attempt + 1}/{max_retries})")

            target_width = 1920
            target_height = 1080

            if animation_type == 'drift':
                # Use horizontal drift approach from Python file
                success = create_smooth_drift_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    overlay_path, transparency, output_path
                )
            elif animation_type == 'vertical':
                # Use vertical drift approach from Python file
                success = create_smooth_vertical_drift_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    overlay_path, transparency, output_path
                )
            elif animation_type == 'ken_burns':
                # Ken Burns with overlay
                success = create_smooth_ken_burns_video_crop(
                    image_path, duration, 60, target_width, target_height,
                    overlay_path, transparency, output_path
                )
            else:
                # Static animation - keep existing logic but with overlay
                base_filter = f"scale={target_width}:{target_height}:force_original_aspect_ratio=increase,crop={target_width}:{target_height}"
                drift_filter = f"{base_filter},loop=loop=-1:size=1:start=0,setpts=PTS-STARTPTS"

                cmd = [
                    'ffmpeg', "-y", "-loglevel", "error", "-loop", "1", "-i", image_path,
                    "-i", overlay_path,
                    "-filter_complex",
                    f"[0:v]{drift_filter}[base];[1:v]scale={target_width}:{target_height},format=yuva420p,colorchannelmixer=aa={transparency}[ovr];[base][ovr]overlay=0:0",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                    "-t", str(duration), "-pix_fmt", "yuv420p", "-r", "60",
                    "-movflags", "+faststart", "-an", output_path
                ]

                result = subprocess.run(
                    cmd, check=True, capture_output=True, text=True)
                success = True

            if success and verify_video_file(output_path):
                print(
                    f"✅ Video created successfully with overlay (transparency: {transparency})")
                return True
            else:
                print(f"❌ Video verification failed on attempt {attempt + 1}")
                if attempt < max_retries - 1:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    continue
                else:
                    return False

        except Exception as e:
            print(
                f"❌ Error creating video with overlay on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                if os.path.exists(output_path):
                    os.remove(output_path)
                time.sleep(2)
                continue
            else:
                return False

    return False


@functions_framework.http
@billed("image-to-video-processor")
def image_to_video_processor(request):
    """Handle HTTP requests for batch image to video conversion or video loop processing"""

    if request.method == "OPTIONS":
        return add_cors_headers(request, {})

    if request.method != "POST":
        return add_cors_headers(request, {"error": "Method not allowed"}, 405)

    # Verify SERVICE_ROLE_KEY authentication
    if not verify_service_role_key(request):
        return add_cors_headers(request, {"error": "Unauthorized: Invalid SERVICE_ROLE_KEY"}, 401)

    try:
        print(
            "🚀 Starting batch image to video processing with Enhanced FAL-AI STT and Character-Based Missing Word Compensation - FIXED FOR ALL AUDIO FILES")

        # Parse request
        data = request.get_json(silent=True)
        if not data:
            return add_cors_headers(request, {"error": "Invalid JSON body"}, 400)

        # Check for stop request
        if data.get("action") == "stop":
            video_task_id = data.get("video_task_id")
            user_id = data.get("user_id")
            group_id = data.get("group_id")

            if not all([video_task_id, user_id, group_id]):
                return add_cors_headers(request, {"error": "Missing required parameters for stop request"}, 400)

            # Initialize Supabase for stop request
            supabase_url = os.getenv("SUPABASE_URL")
            supabase_key = os.getenv("SUPABASE_SECRET_KEY")
            if not supabase_url or not supabase_key:
                return add_cors_headers(request, {"error": "Server configuration error - missing Supabase credentials"}, 500)

            supabase: Client = create_client(supabase_url, supabase_key)

            # Handle stop request
            result = handle_stop_request(
                supabase, video_task_id, user_id, group_id)
            return add_cors_headers(request, result)

        # Regular processing request
        video_task_id = data.get("video_task_id")
        user_id = data.get("user_id")
        group_id = data.get("group_id")
        batch_number = data.get("batch_number")
        batch_task_id = data.get("batch_task_id")
        batch_start = data.get("batch_start")
        batch_end = data.get("batch_end")
        batch_size = data.get("batch_size", 5)
        tab = data.get("tab", 1)  # Default to tab 1 for non-enterprise users

        # Legacy support for single image processing
        if not batch_number and data.get("image_number"):
            batch_number = 1
            batch_start = data.get("image_number")
            batch_end = data.get("image_number")
            batch_task_id = data.get("task_id")

        if not all([video_task_id, user_id, group_id, batch_number, batch_task_id, batch_start, batch_end]):
            return add_cors_headers(request, {"error": "Missing required parameters"}, 400)

        # Initialize Supabase
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        if not supabase_url or not supabase_key:
            return add_cors_headers(request, {"error": "Server configuration error - missing Supabase credentials"}, 500)

        supabase: Client = create_client(supabase_url, supabase_key)

        # Check if task has been cancelled before processing - FIXED: Use main task ID properly
        try:
            task_check = supabase.table("video_tasks").select(
                "overall_status, video_creation_status").eq("id", video_task_id).execute()
            if task_check.data and len(task_check.data) > 0:
                task_data = task_check.data[0]
                if task_data.get("overall_status") == "cancelled" or task_data.get("video_creation_status") == "cancelled":
                    print(
                        f"Task {video_task_id} has been cancelled, stopping processing")
                    return add_cors_headers(request, {
                        "status": "cancelled",
                        "message": "Task was cancelled before processing could complete"
                    })
        except Exception as e:
            print(
                f"Warning: Could not check task cancellation status: {str(e)}")
            # Continue processing if we can't check status

        # Idempotency check: if this batch is already completed, skip reprocessing.
        # This prevents duplicate work when trigger-next-video retries the same
        # batch_task_id after a fetch timeout (GCF processing > Edge Function timeout).
        try:
            batch_status_check = supabase.table("video_tasks").select(
                "video_creation_status").eq("id", batch_task_id).execute()
            if batch_status_check.data and len(batch_status_check.data) > 0:
                current_batch_status = batch_status_check.data[0].get(
                    "video_creation_status")
                if current_batch_status == "completed":
                    print(
                        f"⚠️ Batch {batch_number} (id: {batch_task_id}) is already completed — skipping reprocessing to avoid duplicates")
                    return add_cors_headers(request, {
                        "status": "already_completed",
                        "message": f"Batch {batch_number} was already processed successfully",
                        "batch_number": batch_number,
                        "batch_task_id": batch_task_id
                    })
        except Exception as e:
            print(
                f"Warning: Could not perform idempotency check for batch {batch_number}: {str(e)}")
            # Continue processing if we can't check status

        # Get main video task details
        task_result = supabase.table("video_tasks").select(
            "*").eq("id", video_task_id).execute()
        if not task_result.data:
            return add_cors_headers(request, {"error": "Video task not found"}, 404)

        task = task_result.data[0]
        settings = task.get("settings", {})

        # Check for video loop
        video_loop_url = task.get("video_loop") or settings.get("video_loop")
        loop_time = task.get("loop_time") or settings.get("loop_time")

        # Get text language for STT processing
        text_language = task.get("text_language") or settings.get(
            "text_language", "english")

        # Get animation and effects settings
        animation_type = task.get("animation_type") or settings.get(
            "animation_type", "drift")
        effects_type = task.get("effects_type") or settings.get(
            "effects_type", "film_grain")

        print(
            f"Processing batch {batch_number} for task {video_task_id}")
        print(f"Video loop URL: {video_loop_url}")
        print(f"Loop time: {loop_time}")
        print(f"Text language: {text_language}")
        print(f"Animation type: {animation_type}")
        print(f"Effects type: {effects_type}")

        # Video loop processing is now handled directly by
        # calculate-video-durations -> trigger-next-video(create_final_video).
        # If this endpoint is called for a loop task, skip processing here.
        if video_loop_url:
            print("Video loop task reached image-to-video-processor; skipping (handled directly by create-final-video)")
            return add_cors_headers(request, {
                "status": "skipped",
                "message": "Video loop tasks are handled directly by create-final-video",
                "video_task_id": video_task_id,
                "batch_number": batch_number,
                "has_video_loop": True
            }, 200)

        # Detect visual type for TTV/ITV processing
        visual_type = task.get('visual_type') or settings.get(
            'visual_type') or 'image'

        # FIXED: STT tokens are already charged by calculate-video-durations on the main task.
        # All batches (including batch 1) only charge the flat 70k per batch.
        tokens_to_add = 70000
        print(f"Batch {batch_number}: {tokens_to_add} tokens")

        # Check user token balance and get safe amount to add
        safe_tokens_to_add = check_user_token_balance(
            supabase, user_id, tokens_to_add)

        # Update batch task status to running
        supabase.table("video_tasks").update({
            "video_creation_status": "running",
            "overall_status": "running",
            "updated_at": "now()"
        }).eq("id", batch_task_id).execute()

        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

        # Get audio path for duration calculation
        audio_path = settings.get(
            "audio_file_path") or settings.get("audio_folder_path")
        model_version = settings.get("model_version", "v6")

        print(f"Audio path from settings: {audio_path}")
        print(f"Model version: {model_version}")

        with tempfile.TemporaryDirectory() as temp_dir:
            successful_videos = []
            failed_images = []
            stored_durations = None
            durations_dict = None

            # If video loop is used, pass through for final video processing
            if video_loop_url:
                print("Video loop detected, passing through for final video processing")

                # Just mark as completed without processing the loop here
                # The actual loop processing will happen in create-final-video
                successful_videos.append({
                    'video_path': video_loop_url,  # Pass the original URL
                    'duration': loop_time or 60,  # Placeholder duration
                    'is_loop': True,
                    'needs_processing': True  # Flag for create-final-video
                })
                print(f"Video loop marked for processing in final video creation")

            elif visual_type in ('ttv', 'itv'):
                # ========== TTV/ITV CLIP PROCESSING ==========
                # Speed-adjust, apply overlay, upload to videos bucket
                # (mirrors image processing pipeline)
                print(
                    f"🎬 {visual_type.upper()} mode: processing pre-generated video clips")

                # Get TTV/ITV clip folder from settings
                ttv_itv_clip_folder = settings.get(
                    'ttv_itv_clip_folder') or settings.get('images_folder_path', '')
                clip_assembly_data = task.get('clip_assembly_data') or {}

                if not ttv_itv_clip_folder:
                    return add_cors_headers(request, {"error": "TTV/ITV clip folder path not found in task settings"}, 400)

                # Check audio_clip flag from task - if True but no clip_assembly_data,
                # assume ALL clips have speech so we still extract & upload their audio
                audio_clip_flag = task.get('audio_clip', False)

                if not clip_assembly_data:
                    if audio_clip_flag:
                        print(
                            "⚠️ No clip_assembly_data found but audio_clip=True — "
                            "assuming all clips have speech, extracting audio from every clip")
                        # Build a synthetic clip_assembly_data that marks every clip as speech
                        total_clips = batch_end - batch_start + 1
                        # We don't know the total clip count here, so use a large list
                        # that covers any batch range (has_speech is checked by index)
                        max_clip_index = batch_end
                        clip_assembly_data = {
                            'has_speech': [True] * max_clip_index,
                            'speed_factors': [1.0] * max_clip_index,
                            'natural_durations': [],
                            'target_durations': [],
                        }
                        print(
                            f"  Synthetic clip_assembly_data: all {max_clip_index} clips marked as speech")
                    else:
                        print(
                            "⚠️ No clip_assembly_data found - clips will be used at original speed")
                        clip_assembly_data = {}

                print(f"  Clip folder: {ttv_itv_clip_folder}")
                print(f"  Batch range: {batch_start}-{batch_end}")
                print(
                    f"  Speed factors available: {len(clip_assembly_data.get('speed_factors', []))}")

                failed_images = []

                # Download overlay based on effects_type (same overlay configs as image mode)
                overlay_path = None
                overlay_available = False

                overlay_configs = {
                    'film_grain': {
                        'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/FilmGrainOverlay.mp4',
                        'transparency': 0.28
                    },
                    'fire_flare': {
                        'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/FireFlareOverlay.mp4',
                        'transparency': 0.20
                    },
                    'light_sparkle': {
                        'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/LigthSparkleOverlay.mp4',
                        'transparency': 0.08
                    },
                    'snow': {
                        'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/SnowOverlay.mp4',
                        'transparency': 0.10
                    }
                }

                if effects_type is not None and effects_type != 'none' and effects_type in overlay_configs:
                    overlay_config = overlay_configs[effects_type]
                    overlay_path = os.path.join(
                        temp_dir, f"{effects_type}_overlay.mp4")
                    overlay_available = download_file(
                        overlay_config['url'], overlay_path, {})
                    if overlay_available:
                        # Validate overlay file is fully written and not truncated
                        import time
                        # Ensure OS file flush before parallel reads
                        time.sleep(0.3)
                        overlay_size = os.path.getsize(overlay_path)
                        if overlay_size < 10000:
                            print(
                                f"⚠️ Overlay file seems truncated ({overlay_size} bytes), re-downloading...")
                            overlay_available = download_file(
                                overlay_config['url'], overlay_path, {})
                            if overlay_available:
                                time.sleep(0.3)
                        if overlay_available:
                            print(
                                f"✅ {effects_type.replace('_', ' ').title()} overlay downloaded (transparency: {overlay_config['transparency']}, size: {os.path.getsize(overlay_path)} bytes)")
                    else:
                        print(
                            f"❌ Overlay download failed, proceeding without overlay")

                # Process TTV/ITV clips in parallel
                print(
                    f"🚀 Starting PARALLEL processing of {batch_end - batch_start + 1} TTV/ITV clips with 3 workers")

                # List clip files once for the whole batch
                list_result = supabase.storage.from_(
                    'stories').list(ttv_itv_clip_folder, {'limit': 1000})
                if not list_result:
                    return add_cors_headers(request, {"error": f"Could not list clips folder: {ttv_itv_clip_folder}"}, 400)

                def natural_key(s):
                    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]

                all_clip_files = sorted(
                    [f['name']
                        for f in list_result if f['name'].endswith('.mp4')],
                    key=natural_key
                )
                print(f"  Found {len(all_clip_files)} total clips in folder")

                successful_videos = []
                failed_images = []

                with ThreadPoolExecutor(max_workers=3) as executor:
                    future_to_clip = {}
                    for clip_number in range(batch_start, batch_end + 1):
                        # Get the filename for this clip number (1-based)
                        if clip_number < 1 or clip_number > len(all_clip_files):
                            print(
                                f"  ❌ Clip {clip_number} out of range (1-{len(all_clip_files)})")
                            failed_images.append(clip_number)
                            continue
                        clip_filename = all_clip_files[clip_number - 1]

                        future = executor.submit(
                            process_single_ttv_clip,
                            clip_number, clip_filename, supabase_url, supabase_key,
                            ttv_itv_clip_folder, temp_dir, clip_assembly_data,
                            effects_type, overlay_path, overlay_available,
                            overlay_configs, user_id, group_id, supabase
                        )
                        future_to_clip[future] = clip_number

                    for future in as_completed(future_to_clip):
                        clip_number = future_to_clip[future]
                        try:
                            result = future.result()
                            if result['success']:
                                successful_videos.append({
                                    'image_number': result.get('image_number', result['clip_number']),
                                    'video_path': result['video_path'],
                                    'duration': result['duration']
                                })
                                print(
                                    f"✅ Clip {clip_number} completed successfully")
                            else:
                                failed_images.append(clip_number)
                                print(
                                    f"❌ Clip {clip_number} failed: {result.get('error', 'Unknown error')}")
                        except Exception as e:
                            print(
                                f"❌ Clip {clip_number} raised exception: {str(e)}")
                            failed_images.append(clip_number)

                print(
                    f"✅ TTV/ITV parallel processing complete: {len(successful_videos)} successful, {len(failed_images)} failed")

            else:
                # Original image processing logic with Enhanced FAL-AI STT - FIXED FOR ALL AUDIO FILES
                print(
                    "No video loop, processing images with Enhanced FAL-AI STT and Character-Based Missing Word Compensation - FIXED FOR ALL AUDIO FILES")

                # Get images folder path from settings
                images_folder_path = settings.get("images_folder_path")
                if not images_folder_path:
                    return add_cors_headers(request, {"error": "Images folder path not found in task settings"}, 400)

                # Get image prompt path for reference (not used for duration calculation anymore)
                image_prompt_path = settings.get("image_prompt_path")

                # Get durations from database (calculated by calculate-video-durations GCloud function)
                stored_durations = task.get("video_durations")

                if stored_durations:
                    print(
                        "✅ Using pre-calculated durations from database (calculated by calculate-video-durations)")
                    durations_dict = stored_durations
                else:
                    print(
                        "⚠️ No durations found in database - this shouldn't happen if calculate-video-durations ran successfully")
                    durations_dict = None

                failed_images = []

                # Download overlay based on effects_type - UPDATED with new overlay configuration including snow
                overlay_path = None
                overlay_available = False
                # Initialize here to avoid UnboundLocalError when effects_type is None
                overlay_configs = {}

                if effects_type is not None and effects_type != 'none':
                    # NEW: Overlay configuration mapping including snow with updated transparency
                    overlay_configs = {
                        'film_grain': {
                            'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/FilmGrainOverlay.mp4',
                            'transparency': 0.28  # Updated from 0.30
                        },
                        'fire_flare': {
                            'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/FireFlareOverlay.mp4',
                            'transparency': 0.20
                        },
                        'light_sparkle': {
                            'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/LigthSparkleOverlay.mp4',
                            'transparency': 0.08
                        },
                        'snow': {  # NEW OVERLAY
                            'url': 'https://yilrqukialrbdzydvwmt.supabase.co/storage/v1/object/public/websitestuff/Overlay/SnowOverlay.mp4',
                            'transparency': 0.10
                        }
                    }

                    if effects_type in overlay_configs:
                        overlay_config = overlay_configs[effects_type]
                        overlay_path = os.path.join(
                            temp_dir, f"{effects_type}_overlay.mp4")
                        overlay_url = overlay_config['url']
                        overlay_transparency = overlay_config['transparency']

                        overlay_available = download_file(
                            overlay_url, overlay_path, {})

                        if overlay_available:
                            # Validate overlay file is fully written and not truncated
                            import time
                            # Ensure OS file flush before parallel reads
                            time.sleep(0.3)
                            overlay_size = os.path.getsize(overlay_path)
                            if overlay_size < 10000:
                                print(
                                    f"⚠️ Overlay file seems truncated ({overlay_size} bytes), re-downloading...")
                                overlay_available = download_file(
                                    overlay_url, overlay_path, {})
                                if overlay_available:
                                    time.sleep(0.3)
                            if overlay_available:
                                print(
                                    f"✅ {effects_type.replace('_', ' ').title()} overlay downloaded successfully (transparency: {overlay_transparency}, size: {os.path.getsize(overlay_path)} bytes)")
                        else:
                            print(
                                f"❌ {effects_type.replace('_', ' ').title()} overlay download failed, proceeding without overlay")
                    else:
                        print(
                            f"⚠️ Unknown effects type: {effects_type}, proceeding without overlay")

                # Process each image in the batch - PARALLEL PROCESSING with 3 workers
                print(
                    f"🚀 Starting PARALLEL processing of {batch_end - batch_start + 1} images with 3 workers")

                successful_videos = []
                failed_images = []

                # Get output_video_name for segmented video folder
                output_video_name = task.get('output_video_name', 'output.mp4')

                # Use ThreadPoolExecutor to process 3 images in parallel
                with ThreadPoolExecutor(max_workers=3) as executor:
                    # Submit all images for processing
                    future_to_image = {}
                    for image_number in range(batch_start, batch_end + 1):
                        future = executor.submit(
                            process_single_image,
                            image_number, batch_start, batch_end, durations_dict,
                            supabase_url, supabase_key, images_folder_path, temp_dir,
                            effects_type, overlay_path, overlay_available, overlay_configs,
                            animation_type, user_id, group_id, supabase,
                            batch_number, video_task_id, output_video_name
                        )
                        future_to_image[future] = image_number

                    # Collect results as they complete
                    for future in as_completed(future_to_image):
                        image_number = future_to_image[future]
                        try:
                            result = future.result()
                            if result['success']:
                                successful_videos.append({
                                    'image_number': result['image_number'],
                                    'video_path': result['video_path'],
                                    'duration': result['duration']
                                })
                                print(
                                    f"✅ Image {image_number} completed successfully")
                            else:
                                failed_images.append(result['image_number'])
                                print(
                                    f"❌ Image {image_number} failed: {result.get('error', 'Unknown error')}")
                        except Exception as e:
                            print(
                                f"❌ Image {image_number} raised exception: {str(e)}")
                            failed_images.append(image_number)

                print(
                    f"✅ Parallel processing complete: {len(successful_videos)} successful, {len(failed_images)} failed")

            # Final check for cancellation before updating status - FIXED: Use proper error handling
            try:
                task_check = supabase.table("video_tasks").select(
                    "overall_status, video_creation_status").eq("id", video_task_id).execute()
                if task_check.data and len(task_check.data) > 0:
                    task_data = task_check.data[0]
                    if task_data.get("overall_status") == "cancelled" or task_data.get("video_creation_status") == "cancelled":
                        print(
                            f"Task {video_task_id} was cancelled, not updating completion status")
                        return add_cors_headers(request, {
                            "status": "cancelled",
                            "message": "Task was cancelled before completion"
                        })
            except Exception as e:
                print(
                    f"Warning: Could not check final task cancellation status: {str(e)}")
                # Continue with completion if we can't check status

            # UPDATED: Verify videos exist before marking as complete/error
            if video_loop_url:
                batch_progress = 100  # Video loop processing is all-or-nothing
                expected_count = 1
                # For video loop, we don't need to verify storage since it's handled in create-final-video
                videos_verified = True
            else:
                expected_count = batch_end - batch_start + 1
                batch_progress = int(
                    (len(successful_videos) / expected_count) * 100)

                # Verify that uploaded videos actually exist in storage
                verified_videos = []
                for video_info in successful_videos:
                    video_path = video_info['video_path']
                    if verify_video_exists_in_storage(supabase_url, supabase_key, video_path):
                        verified_videos.append(video_info)
                    else:
                        print(
                            f"⚠️ Video not found in storage, removing from successful list: {video_path}")
                        # Add the image number back to failed list if video doesn't exist
                        if 'image_number' in video_info:
                            failed_images.append(video_info['image_number'])

                # Update successful_videos to only include verified ones
                successful_videos = verified_videos
                videos_verified = len(verified_videos) > 0

                # Recalculate progress based on verified videos
                batch_progress = int(
                    (len(verified_videos) / expected_count) * 100)

            # Determine token usage - use safe amount to prevent constraint violations
            tokens_used = safe_tokens_to_add

            batch_update = {
                "video_creation_status": "completed",
                "individual_video_progress": 100,
                "video_creation_progress": batch_progress,
                "completed_individual_videos": len(successful_videos),
                "updated_at": "now()"
            }

            # UPDATED: Always mark as completed regardless of success/failure - errors only logged, not stored in DB
            if len(successful_videos) == expected_count:
                batch_update["overall_status"] = "completed"
            elif len(successful_videos) > 0:
                # Some videos were created successfully, mark as completed
                batch_update["overall_status"] = "completed"
            else:
                # No videos were successfully created — leave batch as 'running'
                # so the cron job (check_stuck_video_tasks) can detect it as stuck
                # and trigger a retry. Do NOT mark as 'completed'.
                if video_loop_url:
                    print(
                        f"❌ Failed to process video loop for batch {batch_number}")
                else:
                    print(
                        f"❌ Failed to create any videos for batch {batch_number}. Failed images: {failed_images}")
                print(
                    f"Leaving batch {batch_number} as 'running' for cron job retry")
                return add_cors_headers(request, {
                    "status": "retry_pending",
                    "message": f"No videos created for batch {batch_number}, leaving as running for cron retry",
                    "batch_number": batch_number,
                    "failed_images": failed_images if not video_loop_url else [],
                }, 200)

            supabase.table("video_tasks").update(
                batch_update).eq("id", batch_task_id).execute()

            # Update main task progress
            batch_tasks = supabase.table("video_tasks").select(
                "*").eq("doc_id", video_task_id).execute()

            if batch_tasks.data:
                total_batches = len(batch_tasks.data)
                completed_batches = len(
                    [t for t in batch_tasks.data if t['video_creation_status'] == 'completed'])

                # Calculate total completed images across all batches
                total_completed_images = sum(
                    [t.get('completed_individual_videos', 0) for t in batch_tasks.data])

                progress = int((completed_batches / (total_batches + 1)) * 100)

                # Update main task
                main_update = {
                    "completed_individual_videos": total_completed_images,
                    "individual_video_progress": progress,
                    "current_batch_number": batch_number,
                    "updated_at": "now()"
                }

                # Update overall progress for all batch tasks
                overall_progress = 80 + \
                    int((completed_batches / total_batches) * 10)  # 80-90%
                supabase.table("video_tasks").update({
                    "overall_progress": overall_progress,
                    "updated_at": "now()"
                }).eq("doc_id", video_task_id).execute()

                # Check if all batches are completed
                if completed_batches >= total_batches:
                    # All batches processed - mark main task as completed
                    main_update.update({
                        "individual_video_status": "completed",
                        "individual_video_progress": 100,
                        "video_creation_status": "pending",
                        "overall_progress": 90,
                        "current_batch_number": None,
                    })

                    supabase.table("video_tasks").update(
                        main_update).eq("id", video_task_id).execute()

                    # Collect all individual video paths
                    all_video_paths = []
                    if video_loop_url:
                        # For video loop, use the single looped video
                        all_video_paths = [v['video_path']
                                           for v in successful_videos]
                    else:
                        # Fetch video_durations from MAIN task (not batch task — batch rows don't have it)
                        # The video_durations field contains a dict like {"1": 205.43, "2": 205.9, ...}
                        # The number of keys tells us how many videos exist
                        print("Fetching video_durations from main task")
                        try:
                            main_task_result = supabase.table("video_tasks").select(
                                "video_durations").eq("id", video_task_id).single().execute()
                            video_durations = main_task_result.data.get(
                                "video_durations", {}) if main_task_result.data else {}
                        except Exception as vd_err:
                            print(
                                f"Warning: Could not fetch main task video_durations: {vd_err}")
                            video_durations = {}

                        if video_durations:
                            # Count the number of video entries
                            video_count = len(video_durations)
                            print(
                                f"Found {video_count} videos in video_durations")

                            # Generate paths: video_1.mp4, video_2.mp4, ..., video_N.mp4
                            all_video_paths = [
                                f"videos/{user_id}/{group_id}/individual_videos/video_{i}.mp4"
                                for i in range(1, video_count + 1)
                            ]
                            print(
                                f"Generated {len(all_video_paths)} video paths: video_1.mp4 to video_{video_count}.mp4")
                        else:
                            print("WARNING: No video_durations found in main task")

                    # Trigger final video creation (which will add audio)
                    try:
                        requests.post(
                            f"{supabase_url}/functions/v1/trigger-next-video",
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                                "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                            },
                            json={
                                "video_task_id": video_task_id,
                                "user_id": user_id,
                                "group_id": group_id,
                                "individual_videos_paths": all_video_paths,
                                "next_step": "create_final_video",
                                "tab": tab
                            }
                        )
                        print("Triggered final video creation (will add audio)")
                    except:
                        print("Fire-and-forget trigger for final video creation")

                else:
                    # Update main task and trigger next batch
                    supabase.table("video_tasks").update(
                        main_update).eq("id", video_task_id).execute()

                    # Trigger next batch processing
                    try:
                        requests.post(
                            f"{supabase_url}/functions/v1/trigger-next-video",
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {(os.getenv('SUPABASE_SECRET_KEY') or supabase_key)}",
                                "apikey": (os.getenv('SUPABASE_SECRET_KEY') or supabase_key),
                            },
                            json={
                                "video_task_id": video_task_id,
                                "user_id": user_id,
                                "group_id": group_id,
                                "next_step": "process_images",
                                "completed_batch": batch_number,
                                "tab": tab
                            }
                        )
                        print("Triggered next batch processing")
                    except:
                        print("Fire-and-forget trigger for next batch")

            # ── Runtime-log metadata ────────────────────────────────────
            # Record what work this batch invocation actually did so we can
            # calibrate the per-image / per-second constants in
            # timeEstimates.ts from real GCF runtimes.
            try:
                # Sum durations for the images this batch covered (1-indexed
                # keys like {"7": 56.99, ...}). Falls back to None when
                # video_durations isn't populated yet.
                _vd = task.get("video_durations") or {}
                _batch_sum = None
                if isinstance(_vd, dict) and _vd:
                    try:
                        _batch_sum = round(
                            sum(float(_vd.get(str(i), 0) or 0)
                                for i in range(int(batch_start), int(batch_end) + 1)),
                            3,
                        )
                    except Exception:
                        _batch_sum = None
                add_billing_metadata(
                    request,
                    visual_type=visual_type,
                    batch_number=batch_number,
                    batch_start=batch_start,
                    batch_end=batch_end,
                    images_in_batch=expected_count if 'expected_count' in locals() else None,
                    successful_videos=len(successful_videos),
                    failed_images=len(failed_images) if isinstance(
                        failed_images, list) else 0,
                    batch_video_seconds=_batch_sum,
                    total_audio_duration=task.get("total_audio_duration"),
                    total_individual_videos=task.get(
                        "total_individual_videos"),
                    image_amount=task.get("image_amount"),
                    has_overlay=bool(animation_type) or bool(effects_type),
                    animation_type=animation_type,
                    effects_type=effects_type,
                    has_transitions=bool(task.get("transition_type")),
                    transition_type=task.get("transition_type"),
                    has_subtitles=bool(task.get("subtitles")),
                    use_existing_audio=bool(
                        task.get("settings", {}).get("use_existing_audio")),
                    has_video_loop=bool(video_loop_url),
                )
            except Exception as _meta_err:
                print(f"[metadata] image-to-video-processor: {_meta_err}")

            return add_cors_headers(request, {
                "status": "success",
                "message": f"Successfully processed batch {batch_number}" + (f" with video loop" if video_loop_url else f" (images {batch_start}-{batch_end}) using Enhanced FAL-AI STT with Character-Based Missing Word Compensation - FIXED FOR ALL AUDIO FILES"),
                "batch_number": batch_number,
                "batch_start": batch_start if not video_loop_url else None,
                "batch_end": batch_end if not video_loop_url else None,
                "successful_videos": len(successful_videos),
                "failed_images": failed_images if not video_loop_url else [],
                "total_images_in_batch": expected_count,
                "videos_verified": videos_verified,
                "audio_included": False,
                "audio_format": get_audio_file_extension(model_version),
                "model_version": model_version,
                "completed_batches": completed_batches if 'completed_batches' in locals() else 0,
                "total_batches": total_batches if 'total_batches' in locals() else 0,
                "has_video_loop": bool(video_loop_url),
                "loop_time": loop_time,
                "durations_calculated": stored_durations is not None or (batch_number == 1 and durations_dict is not None) if not video_loop_url else True,
                "total_segments": len(stored_durations or durations_dict or {}) if not video_loop_url else 1,
                "enhanced_stt_enabled": True,
                "fal_ai_whisper": True,
                "character_based_compensation": True,
                "all_audio_files_processed": True,
                "audio_splitting_enabled": True,
                "max_audio_duration": 3000,
                "siliconflow_ai_enabled": bool(os.getenv("SILICONFLOW_API_KEY")),
                "text_language": text_language,
                "stt_language_code": get_stt_language_code(text_language),
                "animation_type": animation_type,
                "effects_type": effects_type,
                "tokens_used": tokens_used,
                "token_limit_reached": safe_tokens_to_add < tokens_to_add,
                "transition_compensation_applied": True
            })

    except Exception as e:
        print(f"General error: {str(e)}")

        # Leave batch status as 'running' so the cron job (check_stuck_video_tasks)
        # can detect it as stuck and trigger a retry. Do NOT mark as 'completed'.
        try:
            if 'batch_task_id' in locals():
                print(
                    f"❌ Enhanced FAL-AI STT batch processing failed for batch {batch_task_id}: {str(e)}")
                # Intentionally NOT updating status — batch stays 'running' for cron retry
        except:
            pass

        return add_cors_headers(request, {"error": f"Enhanced FAL-AI STT Error: {str(e)}"}, 500)
