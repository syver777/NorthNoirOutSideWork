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
import math
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
        # Fetch user's current token allocation and usage
        result = supabase.table('user_plans').select(
            'tokens_allocated, tokens_used, rollover_tokens'
        ).eq('user_id', user_id).single().execute()

        if not result.data:
            print(f"No user plan found for user {user_id}")
            return 0

        tokens_allocated = result.data.get('tokens_allocated', 0)
        tokens_used = result.data.get('tokens_used', 0)
        rollover_tokens = result.data.get("rollover_tokens", 0)
        available_tokens = tokens_allocated + rollover_tokens - tokens_used

        print(f"User {user_id} token status:")
        print(f"  Allocated: {tokens_allocated:,}")
        print(f"  Used: {tokens_used:,}")
        print(f"  Available: {available_tokens:,}")
        print(f"  Requested: {tokens_to_add:,}")

        if available_tokens <= 0:
            print("User has reached token limit")
            return 0

        # Return the safe amount to add (capped at available)
        safe_amount = min(tokens_to_add, available_tokens)

        if safe_amount < tokens_to_add:
            print(
                f"Adjusting to add only {safe_amount:,} tokens (up to limit)")

        return safe_amount

    except Exception as e:
        print(f"Error checking token balance: {str(e)}")
        return 0


def calculate_stt_tokens(audio_duration_seconds):
    """Calculate STT tokens based on audio duration and chunk limits"""
    MAX_DURATION_SECONDS = 540  # 9 minutes per STT call
    TOKENS_PER_STT_CALL = 3000

    if audio_duration_seconds <= 0:
        return 0

    if audio_duration_seconds <= MAX_DURATION_SECONDS:
        return TOKENS_PER_STT_CALL
    else:
        num_calls = math.ceil(audio_duration_seconds / MAX_DURATION_SECONDS)
        return num_calls * TOKENS_PER_STT_CALL


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
        name, ext = path_parts
        sanitized_name = re.sub(r'[^a-zA-Z0-9/_-]', '_', name)
        return f"{sanitized_name}.{ext}"
    else:
        sanitized = re.sub(r'[^a-zA-Z0-9/_-]', '_', storage_path)
        return sanitized


def download_file(url, local_path, headers):
    """Download a file with retry logic"""
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.get(
                url, headers=headers, stream=True)
            response.raise_for_status()
            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)
            print(f"Downloaded file to {local_path}")
            return True
        except Exception as e:
            print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt == max_retries - 1:
                raise
            time.sleep(2 ** attempt)
    return False


def get_audio_file_extension(model_version):
    """Get the correct audio file extension based on model version"""
    if model_version == 'v7':
        return 'wav'
    else:  # v6, clone, lemonfox, speechify
        return 'mp3'


def natural_sort_key(s):
    """Key for natural sorting of filenames (e.g., 1.png before 10.png)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split(r'(\d+)', s)]


def clean_text_for_prompts(text: str) -> str:
    """Clean story text to match what the image prompt process and TTS audio both use.

    Mirrors the TypeScript cleanTextForPrompts / cleanTextForTTV and the Python
    setup-audio-tasks cleanText functions:
      - Removes the story title (the first non-chapter, non-bold line)
      - Removes the first chapter header (**Chapter X: ...**)
      - Removes all subsequent chapter headers

    This ensures story_content aligns with:
      1. The image prompt text segments (created after cleanTextForPrompts was applied)
      2. The audio narration (TTS skips title and all chapter headers)

    Without this cleaning the first segment's duration can be miscalculated because
    words from the title / chapter headers appear in story_content but are absent from
    both the image prompts and the audio transcript.
    """
    if not text:
        return text

    # Strip SSML break tags (added when pauses=true)
    text = re.sub(r'<break\s+time="[^"]*"\s*/>', '', text)

    lines = text.split('\n')
    chapter_pattern = re.compile(r'^\*\*Chapter \d+.*\*\*$')

    # Find the first chapter header line
    first_chapter_idx = None
    for i, line in enumerate(lines):
        if chapter_pattern.match(line.strip()):
            first_chapter_idx = i
            break

    if first_chapter_idx is not None:
        # Remove title (everything before the chapter header) AND the header itself,
        # then also strip any subsequent chapter headers from the remaining text.
        start_idx = first_chapter_idx + 1
        remaining_lines = lines[start_idx:]
        cleaned_lines = [
            line for line in remaining_lines
            if not chapter_pattern.match(line.strip())
        ]
        return '\n'.join(cleaned_lines)
    else:
        # No **Chapter X:** markers — fall back to skipping the first non-empty,
        # non-bold line (the plain title) and any remaining bold chapter markers.
        cleaned_lines = []
        skip_first = True
        for line in lines:
            if chapter_pattern.match(line.strip()):
                continue  # Skip chapter headers wherever they appear
            if skip_first and line.strip() and not line.strip().startswith('**'):
                skip_first = False
                continue  # Skip the title line
            skip_first = False
            cleaned_lines.append(line)
        return '\n'.join(cleaned_lines)


# ──────────────────────────────────────────────────────────────
# TTV/ITV SPEECH DETECTION + CLIP DURATION HELPERS
# ──────────────────────────────────────────────────────────────

VOLUME_THRESHOLD_DB = -35.0  # clips quieter than this are definitely silent

# fal-ai cost constants (mirrors SSAIVidGen.py)
_FAL_COST_PER_SECOND = 0.000278
_FAL_MARGIN = 0.20
_FAL_CHARGE_PER_SEC = _FAL_COST_PER_SECOND / (1 - _FAL_MARGIN)
_FAL_TOKEN_PRICE = 2.0 / 1_000_000
FAL_TOKENS_PER_SECOND = _FAL_CHARGE_PER_SEC / _FAL_TOKEN_PRICE  # ~173.75


def get_video_duration_ffprobe(video_path: str) -> Optional[float]:
    """Get video duration using ffprobe."""
    try:
        cmd = [
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', video_path
        ]
        result = subprocess.run(
            cmd, capture_output=True, text=True)
        if result.returncode == 0 and result.stdout.strip():
            return float(result.stdout.strip())
    except Exception as e:
        print(f"Error getting video duration: {e}")
    return None


def check_audio_volume(video_path: str) -> float:
    """Return mean volume (dBFS) via ffmpeg volumedetect. -999.0 if no audio."""
    cmd = ['ffmpeg', '-i', video_path, '-af',
           'volumedetect', '-f', 'null', '-']
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True)
        for line in result.stderr.split('\n'):
            if 'mean_volume' in line:
                val = line.split('mean_volume:')[1].strip().split()[0]
                return float(val)
    except Exception:
        pass
    return -999.0


def detect_speech_fal(audio_url: str) -> dict:
    """Call fal-ai Whisper for speech detection.
    Speech requires MORE than 2 words (3+ words).
    """
    t_start = time.time()
    try:
        handle = fal_client.submit(
            "fal-ai/whisper",
            arguments={
                "audio_url": audio_url,
                "task": "transcribe",
                "language": "en",
                "chunk_level": "segment",
            }
        )
        result = handle.get()
        compute_sec = time.time() - t_start
        cost_usd = compute_sec * _FAL_COST_PER_SECOND
        tokens = int(compute_sec * FAL_TOKENS_PER_SECOND)
        transcript = (result.get('text', '') or '').strip()
        has_speech = len(transcript.split()) > 2  # 3+ words required
        # Filter repetitive patterns like "ha ha ha ha"
        if has_speech:
            wds = transcript.lower().split()
            mc, cc = 1, 1
            for ri in range(1, len(wds)):
                if wds[ri] == wds[ri - 1]:
                    cc += 1
                    mc = max(mc, cc)
                else:
                    cc = 1
            if mc >= 3:
                has_speech = False
                print(f"    Repetitive pattern ('{wds[0]}' x{mc}), not speech")
        return {
            'has_speech': has_speech, 'transcript': transcript,
            'compute_seconds': compute_sec, 'cost_usd': cost_usd,
            'tokens_charged': tokens,
        }
    except Exception as e:
        compute_sec = time.time() - t_start
        print(f"    fal-ai Whisper error: {e}")
        return {
            'has_speech': False, 'transcript': '', 'error': True,
            'compute_seconds': compute_sec, 'cost_usd': 0.0, 'tokens_charged': 0,
        }


def detect_speech_in_clips_cloud(
    supabase_client, clip_folder_path: str, clip_count: int, temp_dir: str
) -> Tuple[List[bool], List[float], int]:
    """Detect speech in TTV/ITV clips stored in the stories bucket.

    Returns:
        has_speech: list of bools per clip
        natural_durations: list of floats (seconds) per clip
        total_tokens: total fal-ai tokens charged
    """
    supabase_url = os.getenv('SUPABASE_URL')
    supabase_key = os.getenv('SUPABASE_SECRET_KEY')
    headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}

    # List clip files in the folder
    list_result = supabase_client.storage.from_(
        'stories').list(clip_folder_path, {'limit': 1000})
    if not list_result:
        print(f"No files found in clip folder: {clip_folder_path}")
        return [False] * clip_count, [5.0] * clip_count, 0

    clip_files = [f['name'] for f in list_result if f['name'].endswith('.mp4')]
    clip_files.sort(key=lambda x: natural_sort_key(x))
    print(f"Found {len(clip_files)} .mp4 clips for speech detection")

    has_speech = []
    natural_durations = []
    total_tokens = 0

    for idx, fname in enumerate(clip_files):
        clip_storage_path = f"{clip_folder_path}/{fname}"
        local_clip = os.path.join(temp_dir, f"clip_{idx}.mp4")

        # Download clip
        download_url = f"{supabase_url}/storage/v1/object/stories/{clip_storage_path}"
        try:
            resp = requests.get(download_url, headers=headers)
            resp.raise_for_status()
            with open(local_clip, 'wb') as f:
                f.write(resp.content)
        except Exception as e:
            print(f"  Clip {idx+1} ({fname}): download failed ({e})")
            has_speech.append(False)
            natural_durations.append(5.0)
            continue

        # Get natural duration
        dur = get_video_duration_ffprobe(local_clip)
        natural_durations.append(dur if dur else 5.0)

        # Volume check
        mean_vol = check_audio_volume(local_clip)
        if mean_vol < VOLUME_THRESHOLD_DB:
            print(f"  Clip {idx+1} ({fname}): silent ({mean_vol:.1f} dB)")
            has_speech.append(False)
            try:
                os.remove(local_clip)
            except OSError:
                pass
            continue

        # Extract audio for Whisper
        tmp_wav = os.path.join(temp_dir, f"stt_clip_{idx}.wav")
        try:
            subprocess.run([
                'ffmpeg', '-y', '-i', local_clip,
                '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
                tmp_wav
            ], check=True, capture_output=True)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            print(f"  Clip {idx+1} ({fname}): no audio stream")
            has_speech.append(False)
            try:
                os.remove(local_clip)
            except OSError:
                pass
            continue

        if os.path.getsize(tmp_wav) < 1000:
            print(f"  Clip {idx+1} ({fname}): audio too short")
            has_speech.append(False)
            for p in (local_clip, tmp_wav):
                try:
                    os.remove(p)
                except OSError:
                    pass
            continue

        # Upload to fal and run Whisper
        try:
            audio_url = fal_client.upload_file(tmp_wav)
        except Exception as e:
            print(f"  Clip {idx+1} ({fname}): upload failed ({e})")
            has_speech.append(False)
            for p in (local_clip, tmp_wav):
                try:
                    os.remove(p)
                except OSError:
                    pass
            continue

        result = detect_speech_fal(audio_url)
        total_tokens += result.get('tokens_charged', 0)

        if result['has_speech']:
            t = result['transcript'][:60]
            print(f"  Clip {idx+1} ({fname}): SPEECH — \"{t}...\"")
        else:
            print(f"  Clip {idx+1} ({fname}): no speech ({mean_vol:.1f} dB)")

        has_speech.append(result['has_speech'])

        # Cleanup
        for p in (local_clip, tmp_wav):
            try:
                os.remove(p)
            except OSError:
                pass

    speech_count = sum(has_speech)
    print(
        f"Speech detection complete: {speech_count}/{len(has_speech)} clips have speech")
    print(f"Total speech detection tokens: {total_tokens:,}")
    return has_speech, natural_durations, total_tokens


def redistribute_durations_for_speech(
    target_durations: list,
    natural_durations: list,
    has_speech: list
) -> list:
    """Redistribute narration time away from speech clips to nearby non-speech clips.

    For each speech clip the narration duration assigned to it gets shifted to the
    closest preceding non-speech clips so the voiceover finishes before the speech
    clip starts.  The speech clip itself plays at natural speed.
    """
    n = len(target_durations)
    if not any(has_speech):
        return list(target_durations)

    adjusted = list(target_durations)

    # Build groups of consecutive speech clips
    speech_groups = []
    i = 0
    while i < n:
        if has_speech[i]:
            start = i
            while i < n and has_speech[i]:
                i += 1
            speech_groups.append((start, i - 1))
        else:
            i += 1

    for g_idx, (g_start, g_end) in enumerate(speech_groups):
        group_size = g_end - g_start + 1
        time_to_redistribute = sum(adjusted[j]
                                   for j in range(g_start, g_end + 1))

        # Set speech clips to their natural duration
        for j in range(g_start, g_end + 1):
            adjusted[j] = natural_durations[j]

        max_spread = group_size

        # Find boundary — don't spread past the previous speech group
        earliest_allowed = 0
        if g_idx > 0:
            prev_end = speech_groups[g_idx - 1][1]
            earliest_allowed = prev_end + 1

        # Collect eligible non-speech clips before this group
        spread_targets = []
        for j in range(g_start - 1, earliest_allowed - 1, -1):
            if not has_speech[j]:
                spread_targets.append(j)
            if len(spread_targets) >= max_spread:
                break

        if not spread_targets:
            print(
                f"  No non-speech clips before group [{g_start+1}-{g_end+1}] to absorb narration")
            continue

        extra_per_clip = time_to_redistribute / len(spread_targets)
        for j in spread_targets:
            adjusted[j] += extra_per_clip

        spread_names = ', '.join(str(j+1) for j in sorted(spread_targets))
        print(f"  Speech clips [{g_start+1}-{g_end+1}]: "
              f"{time_to_redistribute:.2f}s narration -> clips {spread_names} "
              f"(+{extra_per_clip:.2f}s each)")

    return adjusted


class STTDurationProcessor:
    """Enhanced STT Duration Processor using FAL-AI Whisper"""

    # Duration limits for STT API - Updated for FAL-AI Whisper
    MAX_DURATION_SECONDS = 540  # 9 minutes max
    TARGET_DURATION_SECONDS = 480  # Target 8 minutes when splitting
    MIN_PART_DURATION = 120  # Minimum 2 minutes per part

    def __init__(self, supabase_url, supabase_key, api_key=None, text_language='english'):
        """Initialize the STT Duration Processor"""
        self.supabase_url = supabase_url
        self.supabase_key = supabase_key
        self.supabase = create_client(supabase_url, supabase_key)
        self.api_key = api_key or os.getenv("FAL_KEY")
        self.groq_key = os.getenv("GROQ_API_KEY")  # fallback transcription
        self.text_language = text_language
        self.temp_files = []

        # Configure FAL client
        if self.api_key:
            os.environ["FAL_KEY"] = self.api_key

    def calculate_chars_per_second_rate(self, all_word_timestamps: List[Dict]) -> float:
        """Calculate average characters per second from word timestamps"""
        if not all_word_timestamps:
            return 13.67  # Default fallback

        total_duration = 0.0
        total_chars = 0

        for entry in all_word_timestamps:
            word = entry.get('word', '')
            start = entry.get('start', 0)
            end = entry.get('end', 0)

            total_chars += len(word)
            total_duration += (end - start)

        if total_duration > 0:
            return total_chars / total_duration
        return 13.67  # Default fallback

    def parse_transcript_words(self, transcript_file: str) -> Dict[str, List[Tuple[float, float, float]]]:
        """Parse transcript words into a dictionary mapping words to their timings"""
        word_timings = {}

        with open(transcript_file, 'r', encoding='utf-8') as f:
            for line in f:
                parts = line.strip().split('\t')
                if len(parts) >= 3:
                    word = parts[0].strip()
                    try:
                        start_time = float(parts[1])
                        end_time = float(parts[2])
                        duration = end_time - start_time

                        if word not in word_timings:
                            word_timings[word] = []
                        word_timings[word].append(
                            (start_time, end_time, duration))
                    except ValueError:
                        continue

        return word_timings

    def get_total_transcript_duration(self, transcript_file: str) -> float:
        """Get the total duration from the transcript file"""
        max_end_time = 0.0

        with open(transcript_file, 'r', encoding='utf-8') as f:
            for line in f:
                parts = line.strip().split('\t')
                if len(parts) >= 3:
                    try:
                        end_time = float(parts[2])
                        max_end_time = max(max_end_time, end_time)
                    except ValueError:
                        continue

        return max_end_time

    def parse_segments(self, segments_file: str) -> List[str]:
        """Parse segments from the segments file"""
        with open(segments_file, 'r', encoding='utf-8') as f:
            content = f.read()

        # Extract segments between square brackets
        blocks = re.findall(r'\[(.*?)\]', content, re.DOTALL)
        segments = []

        for i in range(0, len(blocks), 2):  # Text blocks are at even indices
            if i < len(blocks):
                segments.append(blocks[i].strip())

        return segments

    def tokenize_segment(self, segment: str) -> List[str]:
        """Tokenize a segment into words, preserving punctuation"""
        # Split by whitespace but keep punctuation attached
        tokens = re.findall(r'\S+', segment)
        return tokens

    def find_fuzzy_match(self, word: str, available_words: List[str], cutoff: float = 0.6) -> str:
        """Find fuzzy match for a word"""
        matches = get_close_matches(word, available_words, n=1, cutoff=cutoff)
        return matches[0] if matches else None

    def try_compound_word_split(self, word: str, word_timings: Dict[str, List[Tuple[float, float, float]]], used_word_indices: Dict[str, int]) -> Tuple[float, List[str]]:
        """Try to split compound word into parts and match them"""
        # Try splitting by common separators
        for separator in ['-', '_', "'", '']:
            parts = word.split(separator) if separator else [
                word[i:i+3] for i in range(0, len(word), 3)]

            if len(parts) > 1:
                total_duration = 0.0
                matched_parts = []
                all_matched = True

                for part in parts:
                    if not part:
                        continue

                    clean_part = part.strip(string.punctuation).lower()
                    if clean_part in word_timings:
                        idx = used_word_indices.get(clean_part, 0)
                        if idx < len(word_timings[clean_part]):
                            _, _, duration = word_timings[clean_part][idx]
                            total_duration += duration
                            matched_parts.append(clean_part)
                            used_word_indices[clean_part] = idx + 1
                        else:
                            all_matched = False
                            break
                    else:
                        all_matched = False
                        break

                if all_matched and matched_parts:
                    return total_duration, matched_parts

        return 0.0, []

    def calculate_segment_duration(self, segment: str, word_timings: Dict[str, List[Tuple[float, float, float]]], used_word_indices: Dict[str, int] = None) -> Tuple[float, List[str], List[str], List[str]]:
        """Calculate duration for a segment by matching words with transcript.

        Pass a shared used_word_indices dict across all segment calls so each
        segment consumes transcript words in sequence rather than always
        starting from occurrence [0] of every word.
        """
        tokens = self.tokenize_segment(segment)
        total_duration = 0.0
        if used_word_indices is None:
            used_word_indices = {}  # standalone call — local state only
        missing_words = []
        matched_words = []
        fuzzy_matched_words = []

        for token in tokens:
            clean_token = token.strip(string.punctuation).lower()

            if not clean_token:
                continue

            # Step 1: Exact match
            if clean_token in word_timings:
                idx = used_word_indices.get(clean_token, 0)
                if idx < len(word_timings[clean_token]):
                    _, _, duration = word_timings[clean_token][idx]
                    total_duration += duration
                    matched_words.append(clean_token)
                    used_word_indices[clean_token] = idx + 1
                    continue
                else:
                    # Exhausted all occurrences — reuse the last known timing
                    # rather than marking the word as missing
                    _, _, duration = word_timings[clean_token][-1]
                    total_duration += duration
                    matched_words.append(clean_token)
                    continue

            available_words = list(word_timings.keys())

            # Step 2: Compound word splitting (before fuzzy — more structurally precise)
            compound_duration, compound_parts = self.try_compound_word_split(
                clean_token, word_timings, used_word_indices
            )
            if compound_duration > 0:
                total_duration += compound_duration
                matched_words.extend(compound_parts)
                continue

            # Step 3: Fuzzy match
            fuzzy_match = self.find_fuzzy_match(
                clean_token, available_words, cutoff=0.7)

            if fuzzy_match:
                idx = used_word_indices.get(fuzzy_match, 0)
                if idx < len(word_timings[fuzzy_match]):
                    _, _, duration = word_timings[fuzzy_match][idx]
                    total_duration += duration
                    fuzzy_matched_words.append(f"{clean_token}->{fuzzy_match}")
                    used_word_indices[fuzzy_match] = idx + 1
                    continue
                else:
                    # Exhausted fuzzy match occurrences — reuse last
                    _, _, duration = word_timings[fuzzy_match][-1]
                    total_duration += duration
                    fuzzy_matched_words.append(
                        f"{clean_token}->{fuzzy_match}(reused)")
                    continue

            # Truly missing — compensated by char-rate in the caller
            missing_words.append(clean_token)

        return total_duration, matched_words, fuzzy_matched_words, missing_words

    def distribute_missing_duration(self, results: List[Dict], total_transcript_duration: float, total_calculated_duration: float, target_total_duration: float = None) -> List[Dict]:
        """Distribute missing duration across segments"""
        if target_total_duration:
            missing_duration = target_total_duration - total_calculated_duration
        else:
            missing_duration = total_transcript_duration - total_calculated_duration

        if missing_duration <= 0:
            return results

        total_missing_words = sum(len(r['missing_words']) for r in results)

        if total_missing_words == 0:
            # Distribute proportionally by segment duration
            for result in results:
                proportion = result['duration'] / \
                    total_calculated_duration if total_calculated_duration > 0 else 1.0 / \
                    len(results)
                result['duration'] += missing_duration * proportion
        else:
            # Distribute based on missing words
            for result in results:
                missing_word_count = len(result['missing_words'])
                if missing_word_count > 0:
                    proportion = missing_word_count / total_missing_words
                    result['duration'] += missing_duration * proportion

        return results

    def get_signed_url(self, file_path: str, expires_in: int = 604800) -> Optional[str]:
        """Get signed URL for a file in Supabase storage"""
        try:
            # file_path is the path within the 'stories' bucket
            response = self.supabase.storage.from_('stories').create_signed_url(
                file_path, expires_in
            )

            if 'signedURL' in response:
                return response['signedURL']
            elif isinstance(response, dict) and 'error' in response:
                print(f"Error creating signed URL: {response['error']}")
                return None
            else:
                print(f"Unexpected response format: {response}")
                return None

        except Exception as e:
            print(f"Exception creating signed URL: {str(e)}")
            return None

    def download_file(self, file_path: str, local_path: str) -> bool:
        """Download a file from Supabase storage"""
        try:
            signed_url = self.get_signed_url(file_path)
            if not signed_url:
                return False

            headers = {"Authorization": f"Bearer {self.supabase_key}", "apikey": self.supabase_key}
            response = requests.get(
                signed_url, headers=headers, stream=True)
            response.raise_for_status()

            with open(local_path, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    f.write(chunk)

            print(f"Downloaded {file_path} to {local_path}")
            return True

        except Exception as e:
            print(f"Error downloading file: {str(e)}")
            return False

    def upload_file(self, local_path: str, storage_path: str) -> str:
        """Upload a file to Supabase storage"""
        try:
            bucket_name = storage_path.split('/')[0]
            file_path_in_bucket = '/'.join(storage_path.split('/')[1:])

            with open(local_path, 'rb') as f:
                response = self.supabase.storage.from_(bucket_name).upload(
                    file_path_in_bucket, f, {"content-type": "text/plain"}
                )

            print(f"Uploaded {local_path} to {storage_path}")
            return storage_path

        except Exception as e:
            print(f"Error uploading file: {str(e)}")
            raise

    def get_audio_duration_from_url(self, audio_url: str) -> float:
        """Get audio duration from URL using ffprobe"""
        try:
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as temp_audio:
                temp_audio_path = temp_audio.name

            headers = {"Authorization": f"Bearer {self.supabase_key}", "apikey": self.supabase_key}
            download_file(audio_url, temp_audio_path, headers)

            duration = self.get_audio_duration_local(temp_audio_path)
            os.unlink(temp_audio_path)
            return duration

        except Exception as e:
            print(f"Error getting audio duration: {str(e)}")
            return 0.0

    def get_audio_duration_local(self, file_path: str) -> float:
        """Get audio duration from local file using ffprobe"""
        try:
            cmd = [
                'ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1', file_path
            ]
            result = subprocess.run(
                cmd, capture_output=True, text=True, check=True)
            duration = float(result.stdout.strip())
            return duration

        except Exception as e:
            print(f"Error getting audio duration with ffprobe: {str(e)}")
            return 0.0

    def split_audio_file_by_duration(self, file_path: str, extension: str) -> List[Tuple[int, str, str]]:
        """Split audio file into chunks based on duration limits"""
        try:
            total_duration = self.get_audio_duration_local(file_path)
            print(f"Total audio duration: {total_duration}s")

            if total_duration <= self.MAX_DURATION_SECONDS:
                # No splitting needed
                return [(1, file_path, extension)]

            # Calculate number of parts needed
            num_parts = math.ceil(
                total_duration / self.TARGET_DURATION_SECONDS)
            part_duration = total_duration / num_parts

            print(
                f"Splitting audio into {num_parts} parts of ~{part_duration}s each")

            parts = []
            for i in range(num_parts):
                start_time = i * part_duration

                # Create part file
                part_path = file_path.replace(
                    f'.{extension}', f'_part{i+1}.{extension}')

                cmd = [
                    'ffmpeg', '-i', file_path,
                    '-ss', str(start_time),
                    '-t', str(part_duration),
                    '-c', 'copy',
                    '-y',
                    part_path
                ]

                subprocess.run(cmd, check=True, capture_output=True)
                parts.append((i + 1, part_path, extension))
                self.temp_files.append(part_path)

            return parts

        except Exception as e:
            print(f"Error splitting audio file: {str(e)}")
            return [(1, file_path, extension)]

    def cleanup_temp_files(self):
        """Clean up temporary files"""
        for file_path in self.temp_files:
            try:
                if os.path.exists(file_path):
                    os.unlink(file_path)
            except Exception as e:
                print(f"Error deleting temp file {file_path}: {str(e)}")

    def is_single_audio_file(self, audio_path: str) -> bool:
        """Check if audio_path points to a single file or folder"""
        # Check if the path ends with a valid audio extension
        return audio_path.lower().endswith(('.mp3', '.wav', '.m4a', '.flac', '.aac'))

    def list_audio_files(self, audio_path: str) -> List[Tuple[int, str, str]]:
        """List audio files from folder or single file in Supabase storage"""
        try:
            if self.is_single_audio_file(audio_path):
                # Single file
                extension = audio_path.split('.')[-1]
                return [(1, audio_path, extension)]
            else:
                # Folder - list files
                # audio_path is the path within the 'stories' bucket
                folder_path = audio_path
                if not folder_path.endswith('/'):
                    folder_path += '/'

                response = self.supabase.storage.from_(
                    'stories').list(folder_path, {'limit': 1000})

                if not response:
                    print(f"No files found in {audio_path}")
                    return []

                audio_files = []
                for file_info in response:
                    file_name = file_info['name']
                    if file_name.lower().endswith(('.mp3', '.wav', '.m4a', '.aac')):
                        file_path = f"{audio_path}/{file_name}"
                        extension = file_name.split('.')[-1]

                        # Extract number from filename
                        match = re.search(r'(\d+)', file_name)
                        file_num = int(match.group(1)) if match else len(
                            audio_files) + 1

                        audio_files.append((file_num, file_path, extension))

                # Sort by file number
                audio_files.sort(key=lambda x: x[0])
                return audio_files

        except Exception as e:
            print(f"Error listing audio files: {str(e)}")
            return []

    def transcribe_with_fal(self, audio_url: str, language: str = "en") -> List[Dict]:
        """Transcribe audio using FAL-AI Whisper"""
        try:
            print(
                f"Transcribing audio with FAL-AI Whisper (language: {language})...")

            import fal_client

            result = fal_client.submit(
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
                    "prompt": ""
                }
            )

            # Get the result
            final_result = result.get()

            # Extract word-level timestamps from chunks
            word_timestamps = []
            for chunk in final_result.get('chunks', []):
                # For word-level, text is the word, timestamp is [start, end]
                word_timestamps.append({
                    'word': chunk['text'].strip(),
                    'start': chunk['timestamp'][0],
                    'end': chunk['timestamp'][1]
                })
            print(f"Transcribed {len(word_timestamps)} words")
            return word_timestamps

        except Exception as e:
            print(f"Error transcribing with FAL: {str(e)}")
            return []

    def transcribe_with_groq(self, audio_url: str, language: str = "en") -> List[Dict]:
        """Transcribe audio using Groq Whisper (fallback)"""
        if not self.groq_key:
            print("ERROR: GROQ_API_KEY not found in environment variables")
            return []

        try:
            print(
                f"Transcribing with Groq Whisper (language: {language})... (fallback)")

            # Download audio to temp file (Groq needs file upload)
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as tmp:
                temp_path = tmp.name

            supabase_headers = {"Authorization": f"Bearer {self.supabase_key}", "apikey": self.supabase_key}
            download_file(audio_url, temp_path, supabase_headers)

            with open(temp_path, "rb") as audio_file:
                response = requests.post(
                    "https://api.groq.com/openai/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.groq_key}"},
                    files={"file": audio_file},
                    data={
                        "model": "whisper-large-v3-turbo",
                        "language": language,
                        "response_format": "verbose_json",
                        "timestamp_granularities[]": "word"
                    }
                )

            os.unlink(temp_path)  # cleanup

            response.raise_for_status()
            data = response.json()

            # Convert to exactly the same format your code expects
            word_timestamps = []
            for w in data.get("words", []):
                word_timestamps.append({
                    'word': w.get("word", "").strip(),
                    'start': w.get("start", 0.0),
                    'end': w.get("end", 0.0)
                })

            print(f"✅ Groq success: {len(word_timestamps)} words transcribed")
            return word_timestamps

        except Exception as e:
            print(f"Groq Whisper error: {str(e)}")
            return []

    def transcribe(self, audio_url: str, language: str = "en") -> List[Dict]:
        """NEW: Preferred FAL-AI Whisper. Automatic fallback to Groq on ANY error (502, 500, timeout, etc.)"""
        # Try FAL first (preferred)
        chunks = self.transcribe_with_fal(audio_url, language)

        if chunks:  # FAL succeeded
            return chunks

        # FAL returned empty list → it failed (exactly the errors you showed)
        print(
            "FAL failed (502/500/timeout/etc.) — automatically trying Groq Whisper now...")
        return self.transcribe_with_groq(audio_url, language)

    def preprocess_text(self, text: str) -> str:
        """Preprocess text to normalize formatting"""
        # Remove extra whitespace
        text = ' '.join(text.split())
        # Remove special characters that might cause issues
        text = text.replace('\n', ' ').replace('\r', ' ')
        return text

    def time_to_seconds(self, time_str: str) -> float:
        """Convert time string to seconds"""
        try:
            if ':' in time_str:
                parts = time_str.split(':')
                if len(parts) == 2:
                    return float(parts[0]) * 60 + float(parts[1])
                elif len(parts) == 3:
                    return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            return float(time_str)
        except:
            return 0.0

    def break_sentence_into_words(self, sentence: str, start_time: float, end_time: float) -> List[Dict]:
        """Break a sentence into words with estimated timestamps"""
        words = sentence.split()
        if not words:
            return []

        duration = end_time - start_time
        word_duration = duration / len(words)

        word_timestamps = []
        current_time = start_time

        for word in words:
            word_timestamps.append({
                'word': word,
                'start': current_time,
                'end': current_time + word_duration,
                'timestamp': [current_time, current_time + word_duration]
            })
            current_time += word_duration

        return word_timestamps

    def create_transcript_segments_file(self, word_timestamps: List[Dict], output_path: str = None):
        """Create transcript segments file with word timestamps"""
        if output_path is None:
            output_path = os.path.join(
                tempfile.gettempdir(
                ), f'transcript_words_{uuid.uuid4().hex}.txt'
            )
        try:
            with open(output_path, 'w', encoding='utf-8') as f:
                for entry in word_timestamps:
                    word = entry.get('word', '')
                    # FAL Whisper returns 'start' and 'end' directly
                    start = entry.get('start', 0.0)
                    end = entry.get('end', 0.0)
                    f.write(f"{word}\t{start:.2f}\t{end:.2f}\n")

            self.temp_files.append(output_path)
            return output_path

        except Exception as e:
            print(f"Error creating transcript segments file: {str(e)}")
            return None

    def adjust_segments(self, story_content: str, prompt_content: str, output_path: str = None) -> str:
        """Adjust segments file - currently just passes through"""
        if output_path is None:
            output_path = os.path.join(
                tempfile.gettempdir(
                ), f'AdjustedImagePrompt_{uuid.uuid4().hex}.txt'
            )
        try:
            # For now, just write the prompt content as-is
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(prompt_content)

            self.temp_files.append(output_path)
            return output_path

        except Exception as e:
            print(f"Error adjusting segments: {str(e)}")
            return None

    def process_complete_workflow_with_temp_files(self, audio_path: str, text_segments: List[str], story_content: str, prompt_content: str, language: str = "en", timestamp_level: str = "sentence", target_total_duration: float = None) -> List[float]:
        """Process complete STT workflow and return duration list"""
        try:
            print("=== Starting STT Duration Processing ===")

            # 1. List audio files
            audio_files = self.list_audio_files(audio_path)
            if not audio_files:
                raise Exception("No audio files found")

            print(f"Found {len(audio_files)} audio file(s)")

            # 2. Transcribe all audio files in parallel (3 at a time - I/O bound API calls)
            MAX_PARALLEL_TRANSCRIPTIONS = 3

            def _transcribe_one_file(file_tuple):
                """Download duration + transcribe a single audio file (runs in thread pool)"""
                file_num, file_path, extension = file_tuple
                print(f"[File {file_num}] Starting transcription: {file_path}")

                # Get signed URL
                signed_url = self.get_signed_url(file_path)
                if not signed_url:
                    raise Exception(
                        f"Failed to get signed URL for {file_path}")

                # Download file to get accurate duration
                with tempfile.NamedTemporaryFile(suffix=f'.{extension}', delete=False) as tmp_file:
                    tmp_path = tmp_file.name

                try:
                    if self.download_file(file_path, tmp_path):
                        audio_duration = self.get_audio_duration_local(
                            tmp_path)
                    else:
                        print(
                            f"[File {file_num}] Warning: could not download for duration, using default")
                        audio_duration = 60.0
                finally:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)

                # Transcribe (FAL preferred, Groq fallback)
                chunks = self.transcribe(signed_url, language)
                print(
                    f"[File {file_num}] Done: {len(chunks)} words, duration={audio_duration:.2f}s")
                return file_num, audio_duration, chunks

            # Submit all files to the thread pool and collect results
            file_results = []
            transcription_errors = []
            with ThreadPoolExecutor(max_workers=MAX_PARALLEL_TRANSCRIPTIONS) as executor:
                future_to_file = {
                    executor.submit(_transcribe_one_file, af): af
                    for af in audio_files
                }
                for future in as_completed(future_to_file):
                    af = future_to_file[future]
                    try:
                        file_results.append(future.result())
                    except Exception as exc:
                        transcription_errors.append(
                            f"File {af[0]} ({af[1]}): {exc}")
                        print(
                            f"[File {af[0]}] Error during transcription: {exc}")

            if transcription_errors:
                raise Exception(
                    f"Transcription errors: {'; '.join(transcription_errors)}")

            # Sort by file number to preserve sequential order before applying cumulative offsets
            file_results.sort(key=lambda x: x[0])

            # Build all_word_timestamps with correct cumulative time offsets
            all_word_timestamps = []
            cumulative_time = 0.0

            for file_num, audio_duration, chunks in file_results:
                if chunks:
                    adjusted_words = [
                        {
                            'word': wd['word'],
                            'start': wd['start'] + cumulative_time,
                            'end': wd['end'] + cumulative_time,
                        }
                        for wd in chunks
                    ]
                    all_word_timestamps.extend(adjusted_words)
                    cumulative_time += audio_duration
                    print(
                        f"File {file_num}: {len(chunks)} words merged, cumulative time: {cumulative_time:.2f}s")
                else:
                    print(
                        f"File {file_num}: no words returned, still advancing cumulative time by {audio_duration:.2f}s")
                    cumulative_time += audio_duration

            if not all_word_timestamps:
                raise Exception("No word timestamps generated from audio")

            print(f"\nTotal word timestamps: {len(all_word_timestamps)}")

            # 3. Create transcript words file
            transcript_file = self.create_transcript_segments_file(
                all_word_timestamps)
            if not transcript_file:
                raise Exception("Failed to create transcript file")

            # 4. Parse transcript into word timings dictionary
            word_timings = self.parse_transcript_words(transcript_file)

            # Get total duration from the last word's end time (more accurate)
            total_transcript_duration = all_word_timestamps[-1]['end'] if all_word_timestamps else 0.0

            print(f"Unique words in transcript: {len(word_timings)}")
            print(
                f"Total transcript duration: {total_transcript_duration:.2f}s")

            # 5. Calculate duration for each segment
            # Measure actual speech rate from the transcript for missing-word compensation
            chars_per_second = self.calculate_chars_per_second_rate(
                all_word_timestamps)
            print(f"Character rate: {chars_per_second:.2f} chars/sec")

            # ONE shared dict across ALL segments — each segment consumes words in
            # transcript order instead of always re-starting from occurrence [0]
            shared_word_indices: Dict[str, int] = {}

            results = []
            total_compensated_duration = 0.0

            for i, segment in enumerate(text_segments, 1):
                duration, matched, fuzzy, missing = self.calculate_segment_duration(
                    segment, word_timings, shared_word_indices
                )

                # Compensate for truly missing words using measured char rate
                missing_chars = sum(len(w) for w in missing)
                missing_compensation = missing_chars / \
                    chars_per_second if chars_per_second > 0 else 0.0
                compensated_duration = duration + missing_compensation

                results.append({
                    'segment_number': i,
                    'duration': compensated_duration,
                    'matched_words': matched,
                    'fuzzy_matched_words': fuzzy,
                    'missing_words': missing,
                })

                total_compensated_duration += compensated_duration
                print(
                    f"Segment {i}: {compensated_duration:.2f}s (matched: {len(matched)}, fuzzy: {len(fuzzy)}, missing: {len(missing)}, compensation: +{missing_compensation:.2f}s)")

            print(
                f"\nTotal compensated duration: {total_compensated_duration:.2f}s")
            print(
                f"Total transcript duration: {total_transcript_duration:.2f}s")

            # 6. Apply proportional multiplier so durations sum to the target exactly
            target = target_total_duration if target_total_duration and target_total_duration > 0 else total_transcript_duration
            multiplier = target / total_compensated_duration if total_compensated_duration > 0 else 1.0
            print(
                f"Applying proportional multiplier: {multiplier:.4f} (target={target:.2f}s)")

            for r in results:
                r['duration'] = max(2.0, r['duration'] * multiplier)

            # 7. Extract final durations
            final_durations = [r['duration'] for r in results]

            print("\n=== Final Durations ===")
            for i, duration in enumerate(final_durations, 1):
                print(f"Segment {i}: {duration:.2f}s")

            total_final = sum(final_durations)
            print(f"Total: {total_final:.2f}s")

            return final_durations, all_word_timestamps

        except Exception as e:
            print(f"Error in STT workflow: {str(e)}")
            raise
        finally:
            # Cleanup temp files
            self.cleanup_temp_files()


def parse_image_prompt_document(content):
    """Parse the image prompt document to extract text segments and durations"""
    blocks = re.findall(r'\[(.*?)\]', content, re.DOTALL)
    text_segments = []
    image_prompts = []

    for i in range(0, len(blocks), 2):
        if i < len(blocks):
            text_segments.append(blocks[i].strip())
        if i + 1 < len(blocks):
            image_prompts.append(blocks[i + 1].strip())

    return text_segments, image_prompts


def parse_ttv_prompt_document(content):
    """Parse a TTV/ITV prompt JSON document to extract text segments and video prompts.

    TTV/ITV prompt files are JSON arrays of objects with 'text' (narration segment)
    and 'prompt'/'video_prompt' keys — NOT the bracket-delimited format used by image prompts.
    """
    try:
        data = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        print(
            "Warning: TTV/ITV prompt file is not valid JSON, falling back to bracket parser")
        return parse_image_prompt_document(content)

    text_segments = []
    video_prompts = []

    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict):
                text = item.get('text', '')
                prompt = item.get('prompt') or item.get('video_prompt', '')
                text_segments.append(str(text).strip())
                video_prompts.append(str(prompt).strip())
            elif isinstance(item, str):
                text_segments.append(item.strip())
                video_prompts.append('')
    elif isinstance(data, dict):
        # Handle dict with 'prompts', 'segments', 'videos' keys
        for key in ['prompts', 'videos', 'segments']:
            if key in data and isinstance(data[key], list):
                for item in data[key]:
                    if isinstance(item, dict):
                        text = item.get('text', '')
                        prompt = item.get('prompt') or item.get(
                            'video_prompt', '')
                        text_segments.append(str(text).strip())
                        video_prompts.append(str(prompt).strip())
                    elif isinstance(item, str):
                        text_segments.append(item.strip())
                        video_prompts.append('')
                break

    # Filter out empty segments
    filtered_segments = []
    filtered_prompts = []
    for seg, pmt in zip(text_segments, video_prompts):
        if seg:  # Only include segments with actual text
            filtered_segments.append(seg)
            filtered_prompts.append(pmt)

    print(
        f"Parsed TTV/ITV JSON: {len(filtered_segments)} text segments, {len(filtered_prompts)} prompts")
    return filtered_segments, filtered_prompts


def calculate_durations_with_stt(supabase_url, supabase_key, audio_path, text_segments, story_content, prompt_content, model_version='v6', text_language='english', target_total_duration=None):
    """Calculate durations using STT processor"""
    try:
        # Get language code for STT
        language_code = get_stt_language_code(text_language)

        # Initialize STT processor
        processor = STTDurationProcessor(
            supabase_url=supabase_url,
            supabase_key=supabase_key,
            text_language=text_language
        )

        # Process workflow
        durations, narration_word_timestamps = processor.process_complete_workflow_with_temp_files(
            audio_path=audio_path,
            text_segments=text_segments,
            story_content=story_content,
            prompt_content=prompt_content,
            language=language_code,
            timestamp_level='sentence',
            target_total_duration=target_total_duration
        )

        return durations, narration_word_timestamps

    except Exception as e:
        print(f"Error in STT duration calculation: {str(e)}")
        raise


def calculate_with_fallback(video_task_id, supabase):
    """Calculate durations with fallback to word-count estimation"""
    stt_tokens_used = 0  # Track STT tokens used

    try:
        # Get main task details
        result = supabase.table('video_tasks').select(
            '*').eq('id', video_task_id).single().execute()

        if not result.data:
            raise Exception(f"Video task {video_task_id} not found")

        task = result.data

        # Get required document IDs
        audio_document_id = task.get('audio_document_id')
        image_prompt_document_id = task.get('image_prompt_document_id')
        story_document_id = task.get('story_document_id')

        # Determine visual type and use the correct prompt document ID
        visual_type = task.get('visual_type') or 'image'
        if visual_type == 'ttv':
            # TTV: use ttv_prompt_document_id for segment count
            prompt_document_id = task.get(
                'ttv_prompt_document_id') or image_prompt_document_id
            print(
                f"TTV mode: using ttv_prompt_document_id={prompt_document_id}")
        elif visual_type == 'itv':
            # ITV: use itv_video_prompt_document_id for segment count
            prompt_document_id = task.get(
                'itv_video_prompt_document_id') or image_prompt_document_id
            print(
                f"ITV mode: using itv_video_prompt_document_id={prompt_document_id}")
        else:
            prompt_document_id = image_prompt_document_id

        # Video loop mode: no image prompt document is required.
        # Create a single duration entry and skip STT/image-prompt parsing entirely.
        settings = task.get('settings') or {}
        if isinstance(settings, str):
            try:
                settings = json.loads(settings)
            except Exception:
                settings = {}

        video_loop = task.get('video_loop') or settings.get('video_loop')
        if video_loop:
            print(
                "Video loop detected in calculate_with_fallback - using single loop duration")

            loop_time = task.get('loop_time')
            if loop_time is None:
                loop_time = settings.get('loop_time')

            # loop_time is expected in seconds
            try:
                loop_time = float(loop_time) if loop_time is not None else 0.0
            except Exception:
                loop_time = 0.0

            # Fallback to known audio duration if loop_time is absent/invalid
            if loop_time <= 0:
                total_audio_duration = task.get('total_audio_duration')
                if total_audio_duration is None:
                    total_audio_duration = settings.get('total_audio_duration')
                try:
                    loop_time = float(
                        total_audio_duration) if total_audio_duration is not None else 0.0
                except Exception:
                    loop_time = 0.0

            if loop_time <= 0:
                loop_time = 60.0

            print(f"Using loop duration: {loop_time:.2f}s")
            return [loop_time], 0

        if not audio_document_id:
            raise Exception("No audio_document_id found in task")

        if not prompt_document_id:
            raise Exception(
                f"No prompt document ID found in task (visual_type={visual_type})")

        # Look up audio path from story_documents table
        audio_doc_result = supabase.table('story_documents').select(
            'file_path').eq('id', audio_document_id).single().execute()

        if not audio_doc_result.data:
            raise Exception(
                f"Audio document {audio_document_id} not found in story_documents")

        audio_path = audio_doc_result.data.get('file_path')
        if not audio_path:
            raise Exception("No file_path found in audio document")

        # Look up prompt path from story_documents table (image prompt, TTV prompt, or ITV prompt)
        image_prompt_doc_result = supabase.table('story_documents').select(
            'file_path').eq('id', prompt_document_id).single().execute()

        if not image_prompt_doc_result.data:
            raise Exception(
                f"Prompt document {prompt_document_id} not found in story_documents")

        image_prompt_path = image_prompt_doc_result.data.get('file_path')
        if not image_prompt_path:
            raise Exception("No file_path found in image prompt document")

        # Look up story path from story_documents table (optional)
        story_file_path = None
        if story_document_id:
            try:
                story_doc_result = supabase.table('story_documents').select(
                    'file_path').eq('id', story_document_id).single().execute()
                if story_doc_result.data:
                    story_file_path = story_doc_result.data.get('file_path')
            except Exception as e:
                print(f"Could not fetch story document: {e}")

        # Get Supabase credentials
        supabase_url = os.getenv('SUPABASE_URL')
        supabase_key = os.getenv('SUPABASE_SECRET_KEY')

        # Download image prompt document
        signed_url = supabase.storage.from_('stories').create_signed_url(
            image_prompt_path, 3600
        )

        if 'signedURL' not in signed_url:
            raise Exception("Failed to get signed URL for image prompt")

        response = requests.get(signed_url['signedURL'])
        response.raise_for_status()
        prompt_content = response.text

        # Parse segments (TTV/ITV uses JSON format, images use bracket format)
        if visual_type in ('ttv', 'itv'):
            text_segments, _ = parse_ttv_prompt_document(prompt_content)
            print(
                f"{visual_type.upper()} JSON parsing: found {len(text_segments)} text segments")
        else:
            text_segments, _ = parse_image_prompt_document(prompt_content)

        if not text_segments:
            raise Exception(
                f"No text segments found in prompt document (visual_type={visual_type})")

        # Download story content if available
        story_content = ""
        if story_file_path:
            try:
                story_signed_url = supabase.storage.from_('stories').create_signed_url(
                    story_file_path, 3600
                )
                if 'signedURL' in story_signed_url:
                    story_response = requests.get(
                        story_signed_url['signedURL'])
                    story_response.raise_for_status()
                    raw_story = story_response.text
                    # Clean story text to match the image prompt process and TTS audio:
                    # both strip the title and all chapter headers before use, so
                    # story_content must do the same to avoid counting non-narrated words.
                    story_content = clean_text_for_prompts(raw_story)
                    print(
                        f"Cleaned story content: {len(raw_story)} -> {len(story_content)} chars "
                        f"(removed title/chapter headers)"
                    )
            except Exception as e:
                print(f"Could not download story content: {e}")

        # Calculate total audio duration for token estimation
        total_audio_duration = task.get('total_audio_duration', 0)
        if not total_audio_duration and audio_path:
            print(f"No total_audio_duration in task, calculating from audio files...")
            # Initialize processor to get audio duration
            temp_processor = STTDurationProcessor(
                supabase_url=supabase_url,
                supabase_key=supabase_key,
                text_language=task.get('text_language', 'english')
            )

            # List audio files and sum their durations
            try:
                audio_files = temp_processor.list_audio_files(audio_path)
                if audio_files:
                    total_audio_duration = 0.0
                    for file_num, file_path, extension in audio_files:
                        # Download file temporarily to get duration
                        with tempfile.NamedTemporaryFile(suffix=f'.{extension}', delete=False) as tmp_file:
                            tmp_path = tmp_file.name

                        if temp_processor.download_file(file_path, tmp_path):
                            file_duration = temp_processor.get_audio_duration_local(
                                tmp_path)
                            total_audio_duration += file_duration
                            print(
                                f"  Audio file {file_num}: {file_duration:.1f}s")
                            os.unlink(tmp_path)
                        else:
                            print(f"  Warning: Could not download {file_path}")

                    print(
                        f"Total calculated audio duration: {total_audio_duration:.1f}s")
                else:
                    print("Warning: No audio files found, using default duration")
                    total_audio_duration = 60.0  # Fallback
            except Exception as e:
                print(
                    f"Error calculating audio duration: {str(e)}, using default")
                total_audio_duration = 60.0  # Fallback

        print(
            f"Using audio duration: {total_audio_duration:.1f}s for token calculation")

        # Calculate tokens needed for STT
        stt_tokens_needed = calculate_stt_tokens(total_audio_duration)
        print(
            f"STT tokens needed for {total_audio_duration:.1f}s audio: {stt_tokens_needed:,}")

        # Check user token balance
        user_id = task.get('user_id')
        safe_stt_tokens = check_user_token_balance(
            supabase, user_id, stt_tokens_needed)

        if safe_stt_tokens == 0:
            raise Exception(
                f"Insufficient tokens. Need {stt_tokens_needed:,} tokens for STT processing.")

        if safe_stt_tokens < stt_tokens_needed:
            print(
                f"Warning: Only {safe_stt_tokens:,} tokens available, proceeding with partial processing")

        try:
            # Try STT calculation
            print("Attempting STT duration calculation...")
            durations, narration_word_timestamps = calculate_durations_with_stt(
                supabase_url=supabase_url,
                supabase_key=supabase_key,
                audio_path=audio_path,
                text_segments=text_segments,
                story_content=story_content,
                prompt_content=prompt_content,
                model_version=task.get('model_version', 'v6'),
                text_language=task.get('text_language', 'english'),
                target_total_duration=task.get('total_audio_duration')
            )

            print(f"STT calculation successful: {len(durations)} durations, "
                  f"{len(narration_word_timestamps)} word timestamps")
            stt_tokens_used = safe_stt_tokens  # Mark tokens as used

            # Extend last video by 5s so the final image holds on screen after audio ends
            if durations:
                durations[-1] += 5.0
                print(
                    f"Extended last video duration by 5s → {durations[-1]:.2f}s total")

            # ── TTV/ITV audio_clip speech detection ──────────────────
            clip_assembly_data = None
            audio_clip = task.get('audio_clip', False)

            if audio_clip and visual_type in ('ttv', 'itv'):
                print(
                    f"\n=== audio_clip=true + {visual_type.upper()} — running speech detection ===")

                # Resolve clip folder path
                if visual_type == 'ttv':
                    folder_doc_id = task.get('ttv_folder_document_id')
                else:
                    folder_doc_id = task.get('itv_video_folder_document_id')

                print(f"  folder_doc_id ({visual_type}): {folder_doc_id}")

                clip_folder_path = None
                if folder_doc_id:
                    try:
                        doc_res = supabase.table('story_documents').select(
                            'file_path').eq('id', folder_doc_id).single().execute()
                        if doc_res.data:
                            clip_folder_path = doc_res.data.get('file_path')
                            print(
                                f"  Resolved clip folder path: {clip_folder_path}")
                        else:
                            print(
                                f"  ⚠️ story_documents lookup returned no data for doc_id={folder_doc_id}")
                    except Exception as e:
                        print(
                            f"  ❌ Could not look up clip folder doc (id={folder_doc_id}): {e}")
                else:
                    print(
                        f"  ⚠️ No folder_doc_id found on task for visual_type={visual_type}")

                if clip_folder_path:
                    with tempfile.TemporaryDirectory() as speech_tmp:
                        has_speech, natural_durations, speech_tokens = detect_speech_in_clips_cloud(
                            supabase, clip_folder_path, len(
                                durations), speech_tmp
                        )

                    # Charge speech detection tokens
                    stt_tokens_used += speech_tokens

                    if len(has_speech) == len(durations) and any(has_speech):
                        print(
                            "\nRedistributing narration time away from speech clips...")
                        original_durations = list(durations)
                        durations = redistribute_durations_for_speech(
                            durations, natural_durations, has_speech
                        )

                        # Compute speed factors
                        SPEED_MIN, SPEED_MAX = 0.25, 4.0
                        speed_factors = []
                        for idx, (nat, tgt) in enumerate(zip(natural_durations, durations)):
                            sf = nat / tgt if tgt > 0 else 1.0
                            sf = max(SPEED_MIN, min(SPEED_MAX, sf))
                            speed_factors.append(round(sf, 6))

                        # ── Compensate non-speech clips for transition overlaps ────────
                        # With xfade transitions adjacent clips overlap, reducing available
                        # video time.  Extend non-speech clips so the full narration fits.
                        # (Mirrors SSAIVidGen.py transition compensation logic)
                        task_transition_type = task.get('transition_type')
                        task_transition_duration = 0.5  # default, matches create-final-video.py
                        task_settings = task.get('settings') or {}
                        if isinstance(task_settings, str):
                            try:
                                task_settings = json.loads(task_settings)
                            except Exception:
                                task_settings = {}
                        if task_settings.get('transition_duration'):
                            try:
                                task_transition_duration = float(
                                    task_settings['transition_duration'])
                            except Exception:
                                pass

                        if task_transition_type and task_transition_duration > 0:
                            n_clips = len(durations)
                            total_transition_time = (
                                n_clips - 1) * task_transition_duration
                            # Don't count transitions within speech groups
                            # (those don't eat narration time)
                            _intra_trans = 0
                            _j = 0
                            while _j < len(has_speech):
                                if has_speech[_j]:
                                    _grp_start = _j
                                    while _j < len(has_speech) and has_speech[_j]:
                                        _j += 1
                                    _intra_trans += max(0, _j - _grp_start - 1)
                                else:
                                    _j += 1
                            extension_needed = total_transition_time - \
                                _intra_trans * task_transition_duration
                            non_speech_idx = [
                                i for i in range(n_clips)
                                if i >= len(has_speech) or not has_speech[i]
                            ]
                            if non_speech_idx and extension_needed > 0:
                                total_ns = sum(durations[i]
                                               for i in non_speech_idx)
                                print(f"\nTransition compensation: extending non-speech clips "
                                      f"by {extension_needed:.1f}s (transition_type={task_transition_type}, "
                                      f"duration={task_transition_duration}s)...")
                                for i in non_speech_idx:
                                    durations[i] += (durations[i] /
                                                     total_ns) * extension_needed
                                    sf_e = natural_durations[i] / \
                                        durations[i] if durations[i] > 0 else 1.0
                                    speed_factors[i] = round(
                                        max(SPEED_MIN, min(SPEED_MAX, sf_e)), 6)
                                print(f"  New total: {sum(durations):.1f}s "
                                      f"(+{extension_needed:.1f}s)")
                            else:
                                print(f"Transition compensation: no extension needed "
                                      f"(extension_needed={extension_needed:.1f}s)")
                        else:
                            print(
                                "No transition_type on task — skipping transition compensation")

                        # ── 5-second end padding: slow down last 4 clips (matches SSAIVidGen.py) ──
                        END_PADDING_SECONDS = 5.0
                        pad_count = min(4, len(durations))
                        pad_per_clip = END_PADDING_SECONDS / pad_count
                        print(f"\nAdding {END_PADDING_SECONDS}s end padding across last {pad_count} clips "
                              f"(+{pad_per_clip:.2f}s each)...")
                        for _pi in range(len(durations) - pad_count, len(durations)):
                            durations[_pi] += pad_per_clip
                            sf_new = natural_durations[_pi] / \
                                durations[_pi] if durations[_pi] > 0 else 1.0
                            speed_factors[_pi] = round(
                                max(SPEED_MIN, min(SPEED_MAX, sf_new)), 6)

                        clip_assembly_data = {
                            'has_speech': has_speech,
                            'natural_durations': [round(d, 2) for d in natural_durations],
                            'target_durations': [round(d, 2) for d in durations],
                            'speed_factors': speed_factors,
                            'original_stt_durations': [round(d, 2) for d in original_durations],
                            'narration_word_timestamps': narration_word_timestamps,
                            'text_segments': text_segments,
                            'speech_detection_cost': {
                                'tokens_charged': speech_tokens,
                                'clips_with_speech': sum(has_speech),
                                'total_clips': len(has_speech)
                            }
                        }
                        print(f"clip_assembly_data built: {sum(has_speech)} speech clips, "
                              f"{len(speed_factors)} speed factors, "
                              f"{len(narration_word_timestamps)} word timestamps")
                    else:
                        print(
                            "No speech detected in any clip — no redistribution needed")
                        # Still build clip_assembly_data with natural durations for speed adjustment
                        if len(natural_durations) == len(durations):
                            SPEED_MIN, SPEED_MAX = 0.25, 4.0
                            speed_factors = []
                            for nat, tgt in zip(natural_durations, durations):
                                sf = nat / tgt if tgt > 0 else 1.0
                                sf = max(SPEED_MIN, min(SPEED_MAX, sf))
                                speed_factors.append(round(sf, 6))

                            # ── Compensate clips for transition overlaps ────────
                            # With xfade transitions adjacent clips overlap, reducing available
                            # video time.  Extend clips so the full narration fits.
                            # (Mirrors SSAIVidGen.py transition compensation logic)
                            task_transition_type = task.get('transition_type')
                            task_transition_duration = 0.5  # default, matches create-final-video.py
                            task_settings = task.get('settings') or {}
                            if isinstance(task_settings, str):
                                try:
                                    task_settings = json.loads(task_settings)
                                except Exception:
                                    task_settings = {}
                            if task_settings.get('transition_duration'):
                                try:
                                    task_transition_duration = float(
                                        task_settings['transition_duration'])
                                except Exception:
                                    pass

                            if task_transition_type and task_transition_duration > 0:
                                n_clips = len(durations)
                                total_transition_time = (
                                    n_clips - 1) * task_transition_duration
                                extension_needed = total_transition_time
                                all_idx = list(range(n_clips))
                                if all_idx and extension_needed > 0:
                                    total_dur = sum(durations[i]
                                                    for i in all_idx)
                                    print(f"\nTransition compensation: extending clips "
                                          f"by {extension_needed:.1f}s (transition_type={task_transition_type}, "
                                          f"duration={task_transition_duration}s)...")
                                    for i in all_idx:
                                        durations[i] += (durations[i] /
                                                         total_dur) * extension_needed
                                        sf_e = natural_durations[i] / \
                                            durations[i] if durations[i] > 0 else 1.0
                                        speed_factors[i] = round(
                                            max(SPEED_MIN, min(SPEED_MAX, sf_e)), 6)
                                    print(f"  New total: {sum(durations):.1f}s "
                                          f"(+{extension_needed:.1f}s)")
                                else:
                                    print(f"Transition compensation: no extension needed "
                                          f"(extension_needed={extension_needed:.1f}s)")
                            else:
                                print(
                                    "No transition_type on task — skipping transition compensation")

                            # ── 5-second end padding: slow down last 4 clips (matches SSAIVidGen.py) ──
                            END_PADDING_SECONDS = 5.0
                            pad_count = min(4, len(durations))
                            pad_per_clip = END_PADDING_SECONDS / pad_count
                            print(f"\nAdding {END_PADDING_SECONDS}s end padding across last {pad_count} clips "
                                  f"(+{pad_per_clip:.2f}s each)...")
                            for _pi in range(len(durations) - pad_count, len(durations)):
                                durations[_pi] += pad_per_clip
                                sf_new = natural_durations[_pi] / \
                                    durations[_pi] if durations[_pi] > 0 else 1.0
                                speed_factors[_pi] = round(
                                    max(SPEED_MIN, min(SPEED_MAX, sf_new)), 6)

                            clip_assembly_data = {
                                'has_speech': has_speech,
                                'natural_durations': [round(d, 2) for d in natural_durations],
                                'target_durations': [round(d, 2) for d in durations],
                                'speed_factors': speed_factors,
                                'original_stt_durations': [round(d, 2) for d in durations],
                                'narration_word_timestamps': narration_word_timestamps,
                                'text_segments': text_segments,
                                'speech_detection_cost': {
                                    'tokens_charged': speech_tokens,
                                    'clips_with_speech': 0,
                                    'total_clips': len(has_speech)
                                }
                            }
                else:
                    print(
                        f"❌ Could not resolve clip folder path — skipping speech detection. "
                        f"folder_doc_id={folder_doc_id}, visual_type={visual_type}, "
                        f"ttv_folder_document_id={task.get('ttv_folder_document_id')}, "
                        f"itv_video_folder_document_id={task.get('itv_video_folder_document_id')}"
                    )

            # ── Transition compensation for non-audio_clip path ──────────
            # When audio_clip=false (regular image-based videos, or TTV/ITV
            # without per-clip audio), the clip_assembly_data block above is
            # skipped entirely.  We still need to extend durations so the
            # xfade overlaps don't shorten the video vs. the narration audio.
            # (Mirrors SSAIVidGen.py transition compensation logic)
            if clip_assembly_data is None and durations and len(durations) > 1:
                task_transition_type = task.get('transition_type')
                task_transition_duration = 0.5  # default
                task_settings = task.get('settings') or {}
                if isinstance(task_settings, str):
                    try:
                        task_settings = json.loads(task_settings)
                    except Exception:
                        task_settings = {}
                if task_settings.get('transition_duration'):
                    try:
                        task_transition_duration = float(
                            task_settings['transition_duration'])
                    except Exception:
                        pass

                if task_transition_type and task_transition_duration > 0:
                    n_clips = len(durations)
                    extension_needed = (n_clips - 1) * task_transition_duration
                    total_dur = sum(durations)
                    if total_dur > 0 and extension_needed > 0:
                        print(f"\nTransition compensation (non-audio_clip): extending "
                              f"{n_clips} clips by {extension_needed:.1f}s "
                              f"(transition_type={task_transition_type}, "
                              f"duration={task_transition_duration}s)...")
                        for i in range(n_clips):
                            durations[i] += (durations[i] /
                                             total_dur) * extension_needed
                        print(f"  New total: {sum(durations):.1f}s "
                              f"(+{extension_needed:.1f}s)")
                    else:
                        print(f"Transition compensation: no extension needed "
                              f"(extension_needed={extension_needed:.1f}s)")
                else:
                    print(
                        "No transition_type on task — skipping transition compensation")

                # ── TTV/ITV without audio_clip: build clip_assembly_data with target_durations ──
                # so image-to-video-processor can compute speed factors from natural_dur / target_dur.
                # Also add end padding (matches SSAIVidGen.py which always adds 5s end padding).
                if visual_type in ('ttv', 'itv'):
                    # End padding: +5s across last 4 clips (matches SSAIVidGen.py)
                    END_PADDING_SECONDS = 5.0
                    pad_count = min(4, len(durations))
                    pad_per_clip = END_PADDING_SECONDS / pad_count
                    print(f"\nAdding {END_PADDING_SECONDS}s end padding across last {pad_count} clips "
                          f"(+{pad_per_clip:.2f}s each) [non-audio_clip ITV/TTV]...")
                    for _pi in range(len(durations) - pad_count, len(durations)):
                        durations[_pi] += pad_per_clip

                    clip_assembly_data = {
                        'has_speech': [False] * len(durations),
                        'natural_durations': [],  # not measured yet — image-to-video-processor will measure
                        'target_durations': [round(d, 2) for d in durations],
                        'speed_factors': [],  # computed on the fly by image-to-video-processor
                        'original_stt_durations': [],
                        'narration_word_timestamps': narration_word_timestamps if narration_word_timestamps else [],
                        'text_segments': text_segments if text_segments else [],
                        'speech_detection_cost': {
                            'tokens_charged': 0,
                            'clips_with_speech': 0,
                            'total_clips': len(durations)
                        }
                    }
                    print(f"Built clip_assembly_data for non-audio_clip {visual_type.upper()}: "
                          f"{len(durations)} target_durations (speed_factors will be computed at processing time)")

            return (durations, stt_tokens_used, clip_assembly_data, narration_word_timestamps)

        except Exception as stt_error:
            print(
                f"STT calculation failed: {stt_error}, using word-count fallback")

            # Fallback: Use word-count estimation
            # Prefer the cleaned story_content word count (title/chapter-headers stripped)
            # because it matches the narrated audio content, not the raw story file.
            if story_content:
                word_count = len(story_content.split())
                print(f"Fallback using cleaned story word count: {word_count}")
            else:
                word_count = task.get('word_count', 1000)
                print(f"Fallback using task word_count: {word_count}")
            image_count = len(text_segments)

            # Estimate: ~125 words per minute
            total_duration = (word_count / 125) * 60
            avg_duration = total_duration / image_count if image_count > 0 else 10.0

            # Create fallback durations
            durations = [avg_duration for _ in range(image_count)]

            # Store error in database
            supabase.table('video_tasks').update({
                'error_message': f'Duration calculation fallback used: {str(stt_error)}'
            }).eq('id', video_task_id).execute()

            print(
                f"Using fallback durations: {image_count} segments, {avg_duration:.2f}s each")

            # Extend last video by 5s so the final image holds on screen after audio ends
            if durations:
                durations[-1] += 5.0
                print(
                    f"Extended last video duration by 5s → {durations[-1]:.2f}s total")

            # ── Transition compensation for fallback path ──────────
            if durations and len(durations) > 1:
                task_transition_type = task.get('transition_type')
                task_transition_duration = 0.5  # default
                task_settings = task.get('settings') or {}
                if isinstance(task_settings, str):
                    try:
                        task_settings = json.loads(task_settings)
                    except Exception:
                        task_settings = {}
                if task_settings.get('transition_duration'):
                    try:
                        task_transition_duration = float(
                            task_settings['transition_duration'])
                    except Exception:
                        pass

                if task_transition_type and task_transition_duration > 0:
                    n_clips = len(durations)
                    extension_needed = (n_clips - 1) * task_transition_duration
                    total_dur = sum(durations)
                    if total_dur > 0 and extension_needed > 0:
                        print(f"\nTransition compensation (fallback): extending "
                              f"{n_clips} clips by {extension_needed:.1f}s "
                              f"(transition_type={task_transition_type}, "
                              f"duration={task_transition_duration}s)...")
                        for i in range(n_clips):
                            durations[i] += (durations[i] /
                                             total_dur) * extension_needed
                        print(f"  New total: {sum(durations):.1f}s "
                              f"(+{extension_needed:.1f}s)")

            # Return tuple with 0 tokens for fallback, no clip_assembly_data, no word timestamps
            return (durations, 0, None, [])

    except Exception as e:
        print(f"Error in calculate_with_fallback: {str(e)}")
        raise


def allocate_batches_by_duration(video_durations: List[float], animation_type: str, visual_type: str = 'image') -> List[Dict]:
    """
    Allocate images/clips into batches based on:
    - Max 300 seconds total duration per batch
    - Max 10 images per batch (image mode)
    - Max 20 clips per batch (TTV/ITV mode — clips processed by image-to-video-processor)
    - Videos >300s get their own batch (optimized video creation will handle them quickly)
    """
    # Seconds-based row packing: image=300s, TTV/ITV=180s; cap at 15 images/row.
    MAX_BATCH_DURATION = 180 if visual_type in ('ttv', 'itv') else 300
    MAX_BATCH_IMAGES = 15

    batches = []
    current_batch_images = []
    current_batch_duration = 0.0

    for image_num, duration in enumerate(video_durations, start=1):
        # Long video (>300s) - put in its own batch for optimized processing
        if duration > MAX_BATCH_DURATION:
            # Save current batch if it has images
            if current_batch_images:
                batches.append({
                    'batch_number': len(batches) + 1,
                    'images': current_batch_images.copy(),
                    'duration': current_batch_duration
                })
                current_batch_images = []
                current_batch_duration = 0.0

            # Create dedicated batch for this long video
            batches.append({
                'batch_number': len(batches) + 1,
                'images': [image_num],
                'duration': duration,
                'is_long_video': True  # Flag for optimized processing
            })

        # Normal video - try to fit into current batch
        elif current_batch_duration + duration <= MAX_BATCH_DURATION and len(current_batch_images) < MAX_BATCH_IMAGES:
            current_batch_images.append(image_num)
            current_batch_duration += duration

        # Current batch is full - start new batch
        else:
            # Save current batch
            if current_batch_images:
                batches.append({
                    'batch_number': len(batches) + 1,
                    'images': current_batch_images.copy(),
                    'duration': current_batch_duration
                })

            # Start new batch with current image
            current_batch_images = [image_num]
            current_batch_duration = duration

    # Add final batch if it has images
    if current_batch_images:
        batches.append({
            'batch_number': len(batches) + 1,
            'images': current_batch_images.copy(),
            'duration': current_batch_duration
        })

    return batches


def format_video_durations(durations: List[float], batch_allocations: List[Dict]) -> Dict:
    """
    Format video_durations as simple duration mapping:
    {
        "1": 15.5,
        "2": 920.0,
        "3": 45.0
    }
    """
    formatted = {}

    # Add all durations
    for i, duration in enumerate(durations, start=1):
        formatted[str(i)] = round(duration, 2)

    return formatted


def create_batch_rows(supabase, main_task_id, batch_allocations, main_task_data):
    """Create video_tasks rows for each batch"""
    try:
        batch_rows = []

        for batch in batch_allocations:
            batch_data = {
                'doc_id': main_task_id,  # Link to main task
                'user_id': main_task_data['user_id'],
                'group_id': main_task_data['group_id'],
                'story_title': main_task_data['story_title'],
                'description': main_task_data['description'],
                'current_batch_number': batch['batch_number'],
                'processing_batch_start': batch['images'][0],
                'processing_batch_end': batch['images'][-1],
                'batch_size': len(batch['images']),

                # Copy all relevant settings from main task
                'settings': main_task_data.get('settings', {}),
                'image_style': main_task_data.get('image_style'),
                'use_character_descriptions': main_task_data.get('use_character_descriptions', False),
                'first_page_frequency': main_task_data.get('first_page_frequency'),
                'rest_frequency': main_task_data.get('rest_frequency'),
                'image_model': main_task_data.get('image_model'),
                'voice': main_task_data.get('voice'),
                'language': main_task_data.get('language'),
                'model_version': main_task_data.get('model_version'),
                'speed': main_task_data.get('speed'),
                'preference': main_task_data.get('preference'),
                'remove_title_chapters': main_task_data.get('remove_title_chapters', False),
                'is_clone_voice': main_task_data.get('is_clone_voice', False),
                'clone_voice_name': main_task_data.get('clone_voice_name'),
                'clone_voice_url': main_task_data.get('clone_voice_url'),
                'clone_language': main_task_data.get('clone_language'),
                'output_video_name': main_task_data.get('output_video_name'),
                'variant': main_task_data.get('variant', 1),
                'bg_music': main_task_data.get('bg_music'),
                'bg_music_volume': main_task_data.get('bg_music_volume', 0.25),
                'video_loop': main_task_data.get('video_loop'),
                'loop_time': main_task_data.get('loop_time'),
                'transition_type': main_task_data.get('transition_type'),
                'animation_type': main_task_data.get('animation_type', 'drift'),
                'effects_type': main_task_data.get('effects_type', 'film_grain'),
                'volume': main_task_data.get('volume', 1.0),
                'model': main_task_data.get('model', 'deepseek'),
                'story_model': main_task_data.get('story_model', 'deepseek'),
                'text_language': main_task_data.get('text_language', 'english'),
                'tab': main_task_data.get('tab', 1),

                # Visual pipeline type and TTV/ITV settings
                'visual_type': main_task_data.get('visual_type', 'image'),
                'video_model': main_task_data.get('video_model'),
                'video_duration': main_task_data.get('video_duration'),
                'audio_clip': main_task_data.get('audio_clip', False),
                'itv_model': main_task_data.get('itv_model'),
                'itv_duration': main_task_data.get('itv_duration'),
                'process_ttv': main_task_data.get('process_ttv', False),
                'process_itv': main_task_data.get('process_itv', False),

                # Document IDs (including TTV/ITV)
                'audio_document_id': main_task_data.get('audio_document_id'),
                'image_prompt_document_id': main_task_data.get('image_prompt_document_id'),
                'story_document_id': main_task_data.get('story_document_id'),
                'ttv_prompt_document_id': main_task_data.get('ttv_prompt_document_id'),
                'ttv_folder_document_id': main_task_data.get('ttv_folder_document_id'),
                'itv_image_prompt_document_id': main_task_data.get('itv_image_prompt_document_id'),
                'itv_video_prompt_document_id': main_task_data.get('itv_video_prompt_document_id'),
                'itv_video_folder_document_id': main_task_data.get('itv_video_folder_document_id'),

                # TTV/ITV clip assembly data (speech detection + speed factors)
                'clip_assembly_data': main_task_data.get('clip_assembly_data'),

                # Status fields
                'story_status': 'completed',
                'image_prompt_status': 'completed',
                'image_generation_status': 'completed',
                'audio_status': 'completed',
                'video_creation_status': 'pending',
                'overall_status': 'pending',
                'individual_video_status': 'pending',

                # Progress fields
                'story_progress': 100,
                'image_prompt_progress': 100,
                'image_generation_progress': 100,
                'audio_progress': 100,

                # TTV/ITV status/progress - copy from main task (these phases are complete by batch creation time)
                'ttv_prompt_status': main_task_data.get('ttv_prompt_status', 'completed'),
                'ttv_prompt_progress': main_task_data.get('ttv_prompt_progress', 0),
                'ttv_status': main_task_data.get('ttv_status', 'completed'),
                'ttv_progress': main_task_data.get('ttv_progress', 0),
                'itv_prompt_status': main_task_data.get('itv_prompt_status', 'completed'),
                'itv_prompt_progress': main_task_data.get('itv_prompt_progress', 0),
                'itv_status': main_task_data.get('itv_status', 'completed'),
                'itv_progress': main_task_data.get('itv_progress', 0),
            }

            batch_rows.append(batch_data)

        # Insert all batch rows
        result = supabase.table('video_tasks').insert(batch_rows).execute()

        if result.data:
            print(f"Created {len(result.data)} batch rows")
            return result.data
        else:
            raise Exception("Failed to create batch rows")

    except Exception as e:
        print(f"Error creating batch rows: {str(e)}")
        raise


@functions_framework.http
@billed("calculate-video-durations")
def calculate_video_durations(request):
    """
    Main endpoint: Calculate video durations, allocate batches, and create batch rows
    """
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        headers = {
            'Access-Control-Allow-Origin': get_cors_origin(request),
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
            'Access-Control-Max-Age': '3600'
        }
        return ('', 204, headers)

    # Verify service role key
    if not verify_service_role_key(request):
        return add_cors_headers(request, {'error': 'Unauthorized'}, 401)

    try:
        # Parse request
        request_json = request.get_json()

        video_task_id = request_json.get('video_task_id')
        user_id = request_json.get('user_id')
        group_id = request_json.get('group_id')
        tab = request_json.get('tab', 1)

        if not video_task_id or not user_id or not group_id:
            return add_cors_headers(request, {'error': 'Missing required fields'}, 400)

        print(f"=== Calculating video durations for task {video_task_id} ===")

        # Initialize Supabase
        supabase_url = os.getenv('SUPABASE_URL')
        supabase_key = os.getenv('SUPABASE_SECRET_KEY')
        supabase = create_client(supabase_url, supabase_key)

        # 1. Get main task
        result = supabase.table('video_tasks').select(
            '*').eq('id', video_task_id).single().execute()

        if not result.data:
            return add_cors_headers(request, {'error': 'Video task not found'}, 404)

        main_task = result.data
        animation_type = main_task.get('animation_type', 'drift')
        main_visual_type_for_batches = main_task.get('visual_type') or 'image'

        # ── Motion Graphics (MG) short-circuit ─────────────────────────
        # MG clips are pre-rendered by Remotion-Lambda → already in storage
        # with known per-clip durations on MG_tasks. No STT / prompt-doc
        # parsing is needed; we read the clip rows and jump straight to
        # final assembly (skipping image-to-video-processor entirely).
        if main_visual_type_for_batches == 'mg':
            print("=== MG branch: pulling pre-rendered clips from MG_tasks ===")
            try:
                mg_rows_res = supabase.table('MG_tasks').select(
                    'id, batch_number, video_duration, video_url, status'
                ).eq('video_task_id', video_task_id).order(
                    'batch_number', desc=False).execute()
                mg_rows = (mg_rows_res.data or [])
                if not mg_rows:
                    return add_cors_headers(request, {
                        'error': f'No MG_tasks found for video_task_id={video_task_id}'
                    }, 400)

                mg_clips = []
                mg_durations = []
                for row in mg_rows:
                    dur = float(row.get('video_duration') or 10.0)
                    mg_durations.append(dur)
                    mg_clips.append({
                        'batch_number': row.get('batch_number'),
                        'duration': round(dur, 2),
                        'video_url': row.get('video_url'),
                    })

                mg_formatted = {str(i + 1): round(d, 2)
                                for i, d in enumerate(mg_durations)}
                mg_clip_assembly = {
                    'mg_clips': mg_clips,
                    'speech_detection_cost': {
                        'tokens_charged': 0,
                        'clips_with_speech': 0,
                        'total_clips': len(mg_clips),
                    },
                }

                # Bill a flat base cost (no STT for MG)
                BASE_DURATION_CALC_TOKENS = 50000
                safe_total_tokens = check_user_token_balance(
                    supabase, user_id, BASE_DURATION_CALC_TOKENS)

                supabase.table('video_tasks').update({
                    'video_durations': mg_formatted,
                    'total_individual_videos': len(mg_clips),
                    'clip_assembly_data': mg_clip_assembly,
                    'individual_video_status': 'completed',
                    'individual_video_progress': 100,
                    'mg_status': 'completed',
                    'mg_progress': 100,
                    'video_creation_status': 'pending',
                    'updated_at': 'now()',
                }).eq('id', video_task_id).execute()

                print(f"MG: stored {len(mg_clips)} clips ({sum(mg_durations):.1f}s total). "
                      f"Triggering create_final_video directly.")

                try:
                    requests.post(
                        f"{supabase_url}/functions/v1/trigger-next-video",
                        headers={
                            'Authorization': f'Bearer {(os.getenv("SUPABASE_SECRET_KEY") or supabase_key)}',
                            'apikey': (os.getenv("SUPABASE_SECRET_KEY") or supabase_key),
                            'Content-Type': 'application/json'
                        },
                        json={
                            'video_task_id': video_task_id,
                            'user_id': user_id,
                            'group_id': group_id,
                            'next_step': 'create_final_video',
                            'tab': tab,
                        },
                        timeout=30,
                    )
                except Exception as _trig_err:
                    print(f"MG: trigger-next-video error (non-fatal): {_trig_err}")

                try:
                    add_billing_metadata(
                        request,
                        visual_type='mg',
                        images_processed=len(mg_clips),
                        total_audio_duration=main_task.get('total_audio_duration'),
                        total_video_seconds=round(sum(mg_durations), 3),
                        total_batches=0,
                        stt_tokens_used=0,
                        animation_type=None,
                        effects_type=None,
                        has_overlay=False,
                        has_transitions=False,
                        transition_type=None,
                        has_subtitles=bool(main_task.get('subtitles')),
                        use_existing_audio=False,
                        has_video_loop=False,
                    )
                except Exception as _meta_err:
                    print(f"[metadata] calculate-video-durations MG: {_meta_err}")

                return add_cors_headers(request, {
                    'status': 'success',
                    'message': 'MG durations recorded; final video creation triggered',
                    'video_task_id': video_task_id,
                    'total_clips': len(mg_clips),
                    'video_durations': mg_formatted,
                }, 200)
            except Exception as mg_err:
                print(f"MG branch error: {mg_err}")
                supabase.table('video_tasks').update({
                    'overall_status': 'error',
                    'error_message': f'MG duration calculation error: {mg_err}',
                    'updated_at': 'now()',
                }).eq('id', video_task_id).execute()
                return add_cors_headers(request, {
                    'error': str(mg_err),
                    'status': 'failed',
                }, 500)

        # 2. Calculate durations with fallback (returns 4-tuple: durations, tokens, clip_assembly_data, narration_word_timestamps)
        calc_result = calculate_with_fallback(video_task_id, supabase)
        durations, stt_tokens_used, clip_assembly_data, narration_word_timestamps = calc_result

        print(f"Calculated {len(durations)} video durations")
        print(f"STT tokens used: {stt_tokens_used:,}")
        if clip_assembly_data:
            print(
                f"clip_assembly_data present: {clip_assembly_data.get('speech_detection_cost', {})}")

        # 3. Allocate batches based on durations (visual_type-aware limits)
        batch_allocations = allocate_batches_by_duration(
            durations, animation_type, visual_type=main_visual_type_for_batches)

        print(f"Allocated {len(batch_allocations)} batches")
        for batch in batch_allocations:
            if batch.get('has_segments'):
                print(
                    f"  Batch {batch['batch_number']}: Image {batch['images'][0]} segments {batch['segment_range']} ({batch['total_segments']} total)")
            else:
                print(
                    f"  Batch {batch['batch_number']}: Images {batch['images'][0]}-{batch['images'][-1]} ({batch['duration']:.1f}s)")

        # 4. Format video_durations
        formatted_durations = format_video_durations(
            durations, batch_allocations)

        # 5. Charge base token cost for duration calculation (50k) + STT tokens
        # Check the COMBINED total in a single call so base + STT can never together
        # push tokens_used over tokens_allocated (which would violate the DB constraint).
        BASE_DURATION_CALC_TOKENS = 50000
        total_tokens_needed = BASE_DURATION_CALC_TOKENS + stt_tokens_used
        safe_total_tokens = check_user_token_balance(
            supabase, user_id, total_tokens_needed)
        total_tokens_used = safe_total_tokens
        print(
            f"Total tokens needed: {total_tokens_needed:,} (50k base + {stt_tokens_used:,} STT), Safe total (capped): {safe_total_tokens:,}")

        # 6. Update main task with video_durations, batch count, clip_assembly_data, and total tokens
        update_data = {
            'video_durations': formatted_durations,
            'total_individual_videos': len(batch_allocations),
            'updated_at': 'now()'
        }

        # Store clip_assembly_data if speech detection was performed
        if clip_assembly_data:
            update_data['clip_assembly_data'] = clip_assembly_data
            print(f"Storing clip_assembly_data on main task")

        # Persist narration word timestamps when subtitles are enabled so
        # subtitles.py can skip a second Whisper call on the final video.
        # Hybrid storage: inline for short videos (fast path), gzipped file in
        # the `stories` bucket for long videos to avoid bloating the JSONB
        # column. subtitles.py reads inline first, then falls back to the path.
        try:
            if main_task.get('subtitles') and narration_word_timestamps:
                INLINE_WORD_LIMIT = 8000
                word_count = len(narration_word_timestamps)
                if word_count <= INLINE_WORD_LIMIT:
                    update_data['narration_word_timestamps'] = narration_word_timestamps
                    print(
                        f"Storing {word_count} narration_word_timestamps inline for subtitle burn-in")
                else:
                    # Gzip + upload to stories bucket
                    import gzip
                    import io
                    import json as _json
                    payload = _json.dumps(
                        narration_word_timestamps, separators=(',', ':')).encode('utf-8')
                    buf = io.BytesIO()
                    with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6) as gz:
                        gz.write(payload)
                    gz_bytes = buf.getvalue()
                    storage_path_within_bucket = (
                        f"{user_id}/narration-timestamps/{video_task_id}.json.gz")
                    full_path = f"stories/{storage_path_within_bucket}"
                    try:
                        supabase.storage.from_('stories').upload(
                            storage_path_within_bucket,
                            gz_bytes,
                            {"content-type": "application/gzip",
                             "x-upsert": "true"},
                        )
                    except Exception as _up:
                        # Older supabase-py may not accept x-upsert, try remove+upload
                        try:
                            supabase.storage.from_('stories').remove(
                                [storage_path_within_bucket])
                        except Exception:
                            pass
                        supabase.storage.from_('stories').upload(
                            storage_path_within_bucket,
                            gz_bytes,
                            {"content-type": "application/gzip"},
                        )
                    update_data['narration_word_timestamps_path'] = full_path
                    # Clear the inline column explicitly so stale data from an
                    # earlier attempt never masks the new file.
                    update_data['narration_word_timestamps'] = None
                    print(
                        f"Storing {word_count} narration_word_timestamps as gzipped file "
                        f"({len(gz_bytes)} bytes) at {full_path}")
        except Exception as _e:
            print(f"Skipping narration_word_timestamps persist: {_e}")

        supabase.table('video_tasks').update(
            update_data).eq('id', video_task_id).execute()

        print(f"Updated main task with video_durations and token usage")

        # 6. Create batch rows (inject clip_assembly_data into main_task so batch rows get it,
        #    since main_task was fetched in step 1 before clip_assembly_data was computed)
        if clip_assembly_data:
            main_task['clip_assembly_data'] = clip_assembly_data
        batch_rows = create_batch_rows(
            supabase, video_task_id, batch_allocations, main_task)

        # 7. Trigger next step
        settings = main_task.get('settings') or {}
        if isinstance(settings, str):
            try:
                settings = json.loads(settings)
            except Exception:
                settings = {}

        has_video_loop = bool(main_task.get('video_loop')
                              or settings.get('video_loop'))

        # Determine visual_type for TTV/ITV (clips go through image-to-video-processor for speed-adjust + overlay)
        main_visual_type = main_task.get('visual_type') or 'image'

        if has_video_loop:
            print("Video loop detected - triggering final video creation directly (skipping image-to-video-processor)")
            next_step = 'create_final_video'
        else:
            # Both image mode and TTV/ITV go through image-to-video-processor.
            # TTV/ITV clips get speed-adjusted + overlay applied there before final assembly.
            if main_visual_type in ('ttv', 'itv'):
                print(
                    f"{main_visual_type.upper()} mode - triggering batch processing (speed-adjust + overlay in image-to-video-processor)")
            else:
                print("Image mode - triggering first batch processing")
            next_step = 'process_images'

        trigger_response = requests.post(
            f"{supabase_url}/functions/v1/trigger-next-video",
            headers={
                'Authorization': f'Bearer {(os.getenv("SUPABASE_SECRET_KEY") or supabase_key)}',
                'apikey': (os.getenv("SUPABASE_SECRET_KEY") or supabase_key),
                'Content-Type': 'application/json'
            },
            json={
                'video_task_id': video_task_id,
                'user_id': user_id,
                'group_id': group_id,
                'next_step': next_step,
                'tab': tab
            }
        )

        if trigger_response.ok:
            if has_video_loop:
                print(
                    "Successfully triggered direct final video creation for video loop")
            else:
                print("Successfully triggered first batch processing")
        else:
            print(
                f"Warning: Failed to trigger {next_step}: {trigger_response.text}")

        # ── Runtime-log metadata ────────────────────────────────────────
        # Record what work was done so we can calibrate the
        # `tCalculateDurations` constants in timeEstimates.ts.
        try:
            _total_video_seconds = round(
                sum(float(d or 0) for d in (durations or [])), 3)
            add_billing_metadata(
                request,
                visual_type=main_visual_type_for_batches,
                image_amount=main_task.get('image_amount'),
                images_processed=len(durations or []),
                total_audio_duration=main_task.get('total_audio_duration'),
                total_video_seconds=_total_video_seconds,
                total_batches=len(batch_allocations or []),
                stt_tokens_used=int(stt_tokens_used or 0),
                animation_type=animation_type,
                effects_type=main_task.get('effects_type'),
                has_overlay=bool(animation_type) or bool(
                    main_task.get('effects_type')),
                has_transitions=bool(main_task.get('transition_type')),
                transition_type=main_task.get('transition_type'),
                has_subtitles=bool(main_task.get('subtitles')),
                use_existing_audio=bool(
                    (main_task.get('settings') or {}).get('use_existing_audio')),
                has_video_loop=bool(has_video_loop),
            )
        except Exception as _meta_err:
            print(f"[metadata] calculate-video-durations: {_meta_err}")

        return add_cors_headers(request, {
            'status': 'success',
            'message': 'Video durations calculated and batches created',
            'video_task_id': video_task_id,
            'total_batches': len(batch_allocations),
            'total_images': len(durations),
            'video_durations': formatted_durations
        }, 200)

    except Exception as e:
        print(f"Error in calculate_video_durations: {str(e)}")
        import traceback
        traceback.print_exc()

        # Update task with error
        try:
            supabase.table('video_tasks').update({
                'overall_status': 'error',
                'error_message': f'Duration calculation error: {str(e)}',
                'updated_at': 'now()'
            }).eq('id', video_task_id).execute()
        except:
            pass

        return add_cors_headers(request, {
            'error': str(e),
            'status': 'failed'
        }, 500)
