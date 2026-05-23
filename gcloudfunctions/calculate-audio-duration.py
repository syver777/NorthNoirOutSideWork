import os
import json
import tempfile
import requests
import subprocess
import functions_framework
from supabase import create_client, Client
from mutagen import File as MutagenFile
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


def get_audio_duration_mutagen(file_path):
    """Get duration of a single audio file using mutagen"""
    try:
        audio_file = MutagenFile(file_path)
        if audio_file is not None and audio_file.info:
            return audio_file.info.length
        else:
            print(f"Warning: Could not read duration from {file_path}")
            return 0
    except Exception as e:
        print(f"Error reading audio file {file_path} with mutagen: {e}")
        return 0


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
            # Try to continue with original file
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

        return 0
    except Exception as e:
        print(f"Error in remux_and_get_duration: {e}")
        return 0


def get_audio_duration_ffprobe(file_path):
    """Get duration using ffprobe (for files that don't need remuxing)"""
    try:
        ffprobe_path = os.path.join(os.getcwd(), "ffprobe")
        cmd = [
            ffprobe_path,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            file_path
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
        return 0
    except Exception as e:
        print(f"Error using ffprobe on {file_path}: {e}")
        return 0


def download_file(url, local_path, headers):
    """Download a file with retry logic"""
    max_retries = 5
    for attempt in range(max_retries):
        try:
            response = requests.get(
                url, headers=headers, stream=True)
            response.raise_for_status()

            with open(local_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            return True
        except Exception as e:
            print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                import time
                time.sleep(2)
    return False


def list_files_in_folder(supabase: Client, folder_path: str, bucket_name: str = 'stories') -> list:
    """List all audio files in a Supabase storage folder"""
    try:
        # Normalize folder path (remove trailing slash)
        normalized_path = folder_path.rstrip('/')

        print(f"Listing files in folder: {normalized_path}")

        # List all files in the folder
        response = supabase.storage.from_(bucket_name).list(
            normalized_path, {'limit': 1000})

        if not response:
            print(f"No files found in folder {normalized_path}")
            return []

        # Filter for audio files
        audio_extensions = ('.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac')
        audio_files = []

        for file_info in response:
            file_name = file_info.get('name', '')
            if file_name.lower().endswith(audio_extensions):
                audio_files.append({
                    'path': f"{normalized_path}/{file_name}",
                    'name': file_name,
                    'duration': 0  # Will be calculated
                })

        print(f"Found {len(audio_files)} audio files in folder")
        return audio_files

    except Exception as e:
        print(f"Exception listing files in folder {folder_path}: {str(e)}")
        return []


def create_signed_url(supabase: Client, file_path: str, bucket_name: str = 'stories') -> str:
    """Create a signed URL for accessing private files in Supabase storage"""
    try:
        # Create signed URL with 1 hour expiration
        response = supabase.storage.from_(
            bucket_name).create_signed_url(file_path, 3600)

        # Python SDK returns dict with 'signedURL' key
        if response and isinstance(response, dict):
            # Try different possible keys (SDK versions may vary)
            signed_url = response.get('signedURL') or response.get(
                'signed_url') or response.get('signedUrl')
            if signed_url:
                print(
                    f"✅ Created signed URL for {file_path} in bucket '{bucket_name}'")
                return signed_url

        print(
            f"No signed URL in response for {file_path}. Response: {response}")
        return None
    except Exception as e:
        print(
            f"Exception creating signed URL for {file_path} in bucket '{bucket_name}': {str(e)}")
        return None


@functions_framework.http
@billed("calculate-audio-duration")
def calculate_audio_duration(request):
    """Calculate duration for MP3 and other audio formats (WAV handled by TS)"""

    if request.method == "OPTIONS":
        return add_cors_headers(request, {})

    if request.method != "POST":
        return add_cors_headers(request, {"error": "Method not allowed"}, 405)

    # Verify service role key (accept either legacy SERVICE_ROLE_KEY JWT or new SECRET_KEY during migration)
    # Verify Supabase opaque key (accept either Bearer or apikey header,
    # accept either SECRET (server) or PUBLIC (publishable) key)
    expected_keys = [k for k in (
        os.getenv("SUPABASE_SECRET_KEY"),
        os.getenv("SUPABASE_PUBLIC_KEY"),
    ) if k]
    if not expected_keys:
        return add_cors_headers(request, {"error": "Server configuration error"}, 500)
    _auth_header = request.headers.get('Authorization', '')
    if _auth_header.startswith('Bearer '):
        _token = _auth_header[7:]
    else:
        _token = request.headers.get('apikey', '')
    if not _token or _token not in expected_keys:
        return add_cors_headers(request, {"error": "Unauthorized"}, 401)
    try:
        print("Starting audio duration calculation")

        # Parse request
        data = request.get_json(silent=True)
        if not data:
            return add_cors_headers(request, {"error": "Invalid request body"}, 400)

        # Get files or folder path
        files = data.get("files", [])
        folder_path = data.get("folderPath", "")

        # Initialize Supabase early since we need it for folder listing
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        if not supabase_url or not supabase_key:
            return add_cors_headers(request, {"error": "Supabase configuration missing"}, 500)

        supabase: Client = create_client(supabase_url, supabase_key)

        # Handle folder path input - list all files in folder
        if folder_path:
            print(f"Processing folder: {folder_path}")
            files = list_files_in_folder(supabase, folder_path, 'stories')

            if not files:
                return add_cors_headers(request, {
                    "error": f"No audio files found in folder: {folder_path}",
                    "totalDuration": 0,
                    "filesWithDurations": []
                }, 400)
        elif not files or not isinstance(files, list):
            return add_cors_headers(request, {
                "error": "No audio files or folder path provided",
                "totalDuration": 0,
                "filesWithDurations": []
            }, 400)

        files_with_durations = []
        total_duration = 0

        with tempfile.TemporaryDirectory() as temp_dir:
            for file_info in files:
                file_path = file_info.get("path", "")
                file_url = file_info.get("url", "")
                file_name = file_info.get(
                    "name", "") or file_path.split('/')[-1] or "unknown"

                if not file_url and not file_path:
                    print(f"Skipping file with no URL or path")
                    continue

                print(f"Processing: {file_name} ({file_path})")

                # All audio files are stored in the 'stories' bucket
                # Create signed URL for secure access
                fetch_url = None
                if file_path:
                    signed_url = create_signed_url(
                        supabase, file_path, 'stories')
                    if signed_url:
                        fetch_url = signed_url
                    else:
                        print(f"Could not create signed URL for {file_path}")
                        continue
                elif file_url:
                    # If only URL provided without path, try to use it
                    fetch_url = file_url

                # Download file
                local_file = os.path.join(temp_dir, file_name)
                headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

                if not download_file(fetch_url, local_file, headers):
                    print(f"Failed to download {file_name}")
                    files_with_durations.append({
                        **file_info,
                        "duration": 0,
                        "name": file_name
                    })
                    continue

                # Calculate duration - use remux for ALL MP3s to fix potential structure issues
                # MP3 files can have corrupted structure or bad metadata that ffprobe can't read correctly
                # Remuxing fixes these issues and provides accurate duration
                is_mp3 = file_name.lower().endswith('.mp3')

                if is_mp3:
                    print(f"Detected MP3 file, using remux method for accuracy")
                    duration = remux_and_get_duration_ffmpeg(local_file)
                else:
                    # For non-MP3 files, use regular ffprobe
                    duration = get_audio_duration_ffprobe(local_file)

                # Fallback to mutagen if both methods fail
                if duration <= 0:
                    print(
                        f"Primary methods failed, trying mutagen for {file_name}")
                    duration = get_audio_duration_mutagen(local_file)

                print(f"Duration for {file_name}: {duration:.2f}s")

                files_with_durations.append({
                    **file_info,
                    "duration": duration,
                    "name": file_name
                })

                total_duration += duration

                # Store duration in database if valid - UPDATE existing record in story_documents
                if file_path and duration > 0:
                    try:
                        result = supabase.table("story_documents").update({
                            "audio_duration": duration
                        }).eq("file_path", file_path).execute()
                        print(
                            f"Updated audio_duration={duration}s for {file_path}")
                    except Exception as db_error:
                        print(
                            f"Failed to update duration in database: {str(db_error)}")

        # Sort files by name for consistent ordering (natural sort: 1, 2, 10 not 1, 10, 2)
        def natural_sort_key(file_dict):
            import re
            name = file_dict.get('name', '')
            return [int(text) if text.isdigit() else text.lower()
                    for text in re.split(r'(\d+)', name)]

        files_with_durations.sort(key=natural_sort_key)

        print(
            f"Total duration: {total_duration:.2f}s ({total_duration / 60:.2f} minutes)")
        print(f"Total files processed: {len(files_with_durations)}")

        # REMOVED: No longer updating all files in folder with total duration
        # Each file now has its own individual duration stored above (line 330)
        # This prevents incorrectly updating multiple story_documents records

        response_data = {
            "totalDuration": total_duration,
            "filesWithDurations": files_with_durations
        }

        # ── Runtime-log metadata ────────────────────────────────────────
        # Capture inputs (file count) and output (total audio seconds)
        # so we can calibrate the `tAudioDuration` constants in
        # timeEstimates.ts.
        try:
            add_billing_metadata(
                request,
                files_processed=len(files_with_durations or []),
                total_audio_duration=round(float(total_duration or 0), 3),
            )
        except Exception as _meta_err:
            print(f"[metadata] calculate-audio-duration: {_meta_err}")

        print(
            f"Successfully processed {len(files_with_durations)} files, total duration: {total_duration:.2f}s")
        return add_cors_headers(request, response_data)

    except Exception as e:
        print(f"Error calculating audio duration: {str(e)}")
        import traceback
        traceback.print_exc()
        return add_cors_headers(request, {
            "error": f"Error: {str(e)}",
            "totalDuration": 0,
            "filesWithDurations": []
        }, 500)
