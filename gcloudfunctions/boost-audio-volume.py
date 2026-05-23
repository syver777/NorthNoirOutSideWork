import functions_framework
import json
import os
import subprocess
import tempfile
import requests
from supabase import create_client, Client
import time
import re
import math
import gc
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
                    if chunk:
                        f.write(chunk)
            return True
        except Exception as e:
            print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(2)
    return False


def delete_file_from_supabase(upload_path):
    """Delete existing file from Supabase storage"""
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SECRET_KEY")

    delete_url = f"{supabase_url}/storage/v1/object/stories/{upload_path}"
    headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

    try:
        response = requests.delete(delete_url, headers=headers)
        # 200 = deleted successfully, 404 = file doesn't exist (also OK)
        if response.status_code in [200, 404]:
            print(f"File deletion successful for {upload_path}")
            return True
        else:
            print(
                f"File deletion failed with status {response.status_code}: {response.text}")
            return False
    except Exception as e:
        print(f"Error deleting file: {str(e)}")
        return False


def upload_file_to_supabase(file_path, upload_path, content_type='audio/wav'):
    """Upload file to Supabase storage"""
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SECRET_KEY")

    max_retries = 3
    for attempt in range(max_retries):
        try:
            # First delete existing file to avoid duplicate error
            delete_file_from_supabase(upload_path)

            # Small delay to ensure deletion is processed
            time.sleep(0.5)

            upload_url = f"{supabase_url}/storage/v1/object/stories/{upload_path}"
            headers = {
                "Authorization": f"Bearer {supabase_key}",
                "apikey": supabase_key,
                "Content-Type": content_type
            }

            with open(file_path, "rb") as f:
                response = requests.post(
                    upload_url, data=f, headers=headers)

            if response.status_code == 200:
                print(f"Upload successful for {upload_path}")
                return True
            else:
                print(
                    f"Upload failed with status {response.status_code}: {response.text}")
                if attempt < max_retries - 1:
                    time.sleep(2)
                continue

        except Exception as e:
            print(f"Upload error on attempt {attempt + 1}: {str(e)}")
            if attempt < max_retries - 1:
                time.sleep(2)
            continue

    return False


def apply_volume_boost(input_file, output_file, volume_multiplier):
    """Apply volume boost using FFmpeg with loudnorm filter"""
    try:
        # Calculate target loudness
        gain_db = 20 * math.log10(volume_multiplier)
        target_lufs = -16 + gain_db  # Standard -16 LUFS + boost in dB

        print(
            f"Applying volume boost: {volume_multiplier}x (gain: {gain_db:.2f} dB, target: {target_lufs:.2f} LUFS)")

        # Use FFmpeg loudnorm filter for professional audio processing
        ffmpeg_path = os.path.join(os.getcwd(), "ffmpeg")
        cmd = [
            ffmpeg_path, "-i", input_file,
            "-af", f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
            "-y", output_file
        ]

        result = subprocess.run(
            cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"FFmpeg error: {result.stderr}")
            return False

        print(f"Volume boost applied successfully")
        return True

    except Exception as e:
        print(f"Error applying volume boost: {str(e)}")
        return False


def list_audio_files_in_folder(supabase_url, supabase_key, folder_path):
    """List audio files in a Supabase storage folder, prioritizing grouped/merged files"""
    try:
        headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
        list_url = f"{supabase_url}/storage/v1/object/list/stories"

        list_response = requests.post(
            list_url,
            json={"prefix": folder_path, "limit": 1000},
            headers=headers,
        )

        if list_response.status_code == 200:
            files = list_response.json()
            grouped_files = []
            individual_files = []

            for f in files:
                if f.get("name") and (f["name"].endswith('.mp3') or f["name"].endswith('.wav')):
                    # Construct full path
                    if f["name"] == os.path.basename(f["name"]):
                        full_path = f"{folder_path}/{f['name']}"
                    else:
                        full_path = f["name"]

                    filename = os.path.basename(full_path)

                    # Prioritize grouped/merged files over individual files
                    if filename.startswith('merged.') or filename.startswith('group_'):
                        grouped_files.append(full_path)
                    else:
                        individual_files.append(full_path)

            # Return grouped files if found, otherwise return individual files
            if grouped_files:
                print(
                    f"Found {len(grouped_files)} grouped/merged files: {[os.path.basename(f) for f in grouped_files]}")
                return grouped_files
            else:
                print(f"Found {len(individual_files)} individual files")
                return individual_files

        else:
            print(f"Failed to list files: {list_response.status_code}")
            return []

    except Exception as e:
        print(f"Error listing files: {str(e)}")
        return []


@functions_framework.http
@billed("boost-audio-volume")
def boost_audio_volume(request):
    """Handle HTTP requests for boosting audio volume"""
    start_time = time.time()

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
        print("Starting audio volume boost process")

        # Parse request
        data = request.get_json(silent=True)
        if not data:
            return add_cors_headers(request, {"error": "Invalid JSON body"}, 400)

        user_id = data.get("user_id")
        audio_file_path = data.get("audio_file_path")
        audio_folder_path = data.get("audio_folder_path")
        volume_multiplier = data.get("volume_multiplier", 1.0)
        model_version = data.get("model_version", "v6")
        is_single_file = data.get("is_single_file", False)
        tab = data.get("tab", 1)  # Default to tab 1 for non-enterprise users

        if not user_id:
            return add_cors_headers(request, {"error": "Missing user_id"}, 400)

        if not audio_file_path and not audio_folder_path:
            return add_cors_headers(request, {"error": "Missing audio_file_path or audio_folder_path"}, 400)

        if volume_multiplier < 1.0 or volume_multiplier > 10.0:
            return add_cors_headers(request, {"error": "Volume multiplier must be between 1.0 and 10.0"}, 400)

        # Skip processing if volume is 1.0 (no boost needed)
        if volume_multiplier == 1.0:
            return add_cors_headers(request, {
                "status": "success",
                "message": "No volume boost needed (volume = 1.0)",
                "files_processed": 0,
                "tokens_used": 0
            })

        # Initialize Supabase
        supabase_url = os.getenv("SUPABASE_URL")
        supabase_key = os.getenv("SUPABASE_SECRET_KEY")
        if not supabase_url or not supabase_key:
            return add_cors_headers(request, {"error": "Server configuration error"}, 500)

        supabase: Client = create_client(supabase_url, supabase_key)

        # Determine file extension based on model version
        expected_ext = 'wav' if model_version in ['v6'] else 'mp3'
        content_type = f'audio/{expected_ext}'

        # Get list of files to process
        files_to_process = []

        if is_single_file and audio_file_path:
            files_to_process = [audio_file_path]
        elif audio_folder_path:
            files_to_process = list_audio_files_in_folder(
                supabase_url, supabase_key, audio_folder_path)

        if not files_to_process:
            return add_cors_headers(request, {"error": "No audio files found to process"}, 400)

        print(f"Found {len(files_to_process)} files to process")

        # Calculate tokens needed (100 tokens per file + 500 per minute)
        base_tokens = len(files_to_process) * 100

        # Check user token balance
        if not check_user_token_balance(supabase, user_id, base_tokens):
            return add_cors_headers(request, {"error": "Insufficient tokens"}, 403)

        processed_files = 0
        failed_files = []

        with tempfile.TemporaryDirectory() as temp_dir:
            headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

            # Process files sequentially to avoid memory issues
            for i, file_path in enumerate(files_to_process):
                try:
                    print(
                        f"Processing file {i+1}/{len(files_to_process)}: {file_path}")

                    # Download original file
                    filename = os.path.basename(file_path)
                    local_input_path = os.path.join(
                        temp_dir, f"input_{filename}")
                    local_output_path = os.path.join(
                        temp_dir, f"output_{filename}")

                    download_url = f"{supabase_url}/storage/v1/object/stories/{file_path}"

                    if not download_file(download_url, local_input_path, headers):
                        print(f"Failed to download {file_path}")
                        failed_files.append(file_path)
                        continue

                    # Apply volume boost
                    if not apply_volume_boost(local_input_path, local_output_path, volume_multiplier):
                        print(f"Failed to boost volume for {file_path}")
                        failed_files.append(file_path)
                        # Clean up files
                        try:
                            os.remove(local_input_path)
                        except:
                            pass
                        continue

                    # Upload boosted file (overwrite original)
                    if upload_file_to_supabase(local_output_path, file_path, content_type):
                        processed_files += 1
                        print(f"Successfully processed {file_path}")
                    else:
                        print(f"Failed to upload {file_path}")
                        failed_files.append(file_path)

                    # Clean up temporary files after each file to save memory
                    try:
                        os.remove(local_input_path)
                        os.remove(local_output_path)
                    except:
                        pass

                    # Force garbage collection after each file
                    gc.collect()

                    # Add small delay between files to prevent overwhelming the system
                    if i < len(files_to_process) - 1:
                        time.sleep(0.5)

                except Exception as e:
                    print(f"Error processing {file_path}: {str(e)}")
                    failed_files.append(file_path)
                    # Clean up any temporary files
                    try:
                        if 'local_input_path' in locals():
                            os.remove(local_input_path)
                        if 'local_output_path' in locals():
                            os.remove(local_output_path)
                    except:
                        pass

        # Calculate final token usage (base + time-based)
        elapsed_minutes = math.ceil((time.time() - start_time) / 60)
        time_tokens = elapsed_minutes * 500
        total_tokens = base_tokens + time_tokens

        # Token charging is now handled by the @billed decorator on this
        # function (charges full GCF runtime against the boost-audio-volume
        # rate via _billing.charge_runtime_tokens). The previous
        # update_user_tokens(...) call has been removed to avoid
        # double-charging the user.

        # Prepare response
        response_data = {
            "status": "success" if processed_files > 0 else "error",
            "message": f"Processed {processed_files}/{len(files_to_process)} files",
            "files_processed": processed_files,
            "failed_files": failed_files,
            "volume_multiplier": volume_multiplier,
            "tokens_used": total_tokens,
            "processing_time_minutes": elapsed_minutes
        }

        if failed_files:
            response_data["warning"] = f"{len(failed_files)} files failed to process"

        # ── Runtime-log metadata ────────────────────────────────────────
        # Capture file count + multiplier so we can calibrate the
        # `tAudioBoost` constants in timeEstimates.ts.
        try:
            add_billing_metadata(
                request,
                files_processed=processed_files,
                files_to_process=len(files_to_process or []),
                failed_files=len(failed_files or []),
                volume_multiplier=volume_multiplier,
            )
        except Exception as _meta_err:
            print(f"[metadata] boost-audio-volume: {_meta_err}")

        return add_cors_headers(request, response_data)

    except Exception as e:
        print(f"General error: {str(e)}")
        return add_cors_headers(request, {"error": f"Error: {str(e)}"}, 500)
