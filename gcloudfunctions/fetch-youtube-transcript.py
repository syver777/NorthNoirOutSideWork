import functions_framework
import json
import os
import time

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import GenericProxyConfig
from _billing import billed


ALLOWED_ORIGINS = [
    'https://storyscriptai.com',
    'https://www.storyscriptai.com',
    'https://northnoir.com',
    'https://www.northnoir.com',
    'http://localhost:5173',
]

MAX_TRANSCRIPT_CHARS = 10000  # ~2500 words per video
MAX_PROXY_RETRIES = 5
RETRY_BASE_DELAY = 1.5  # seconds, with exponential backoff


def get_cors_origin(request):
    origin = request.headers.get('Origin', '')
    if origin in ALLOWED_ORIGINS:
        return origin
    return ALLOWED_ORIGINS[0]


def cors_response(request, data, status_code=200):
    headers = {
        'Access-Control-Allow-Origin': get_cors_origin(request),
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        'Access-Control-Max-Age': '3600',
        'Content-Type': 'application/json',
    }
    return json.dumps(data), status_code, headers


def truncate_at_sentence(text, max_chars):
    if len(text) <= max_chars:
        return text
    truncated = text[:max_chars]
    last_end = max(truncated.rfind(
        '.'), truncated.rfind('!'), truncated.rfind('?'))
    if last_end > max_chars * 0.5:
        return truncated[:last_end + 1]
    last_space = truncated.rfind(' ')
    return (truncated[:last_space] + '...') if last_space > 0 else truncated + '...'


def create_transcript_api(proxy_url):
    """Create a fresh YouTubeTranscriptApi instance.

    For DataImpulse rotating proxies, each new connection automatically
    gets a fresh IP — no session ID manipulation needed.
    """
    if not proxy_url:
        return YouTubeTranscriptApi()

    return YouTubeTranscriptApi(
        proxy_config=GenericProxyConfig(
            http_url=proxy_url,
            https_url=proxy_url,
        )
    )


def fetch_single_transcript(video_id):
    """Fetch transcript for a single video, retrying on any error with backoff."""
    proxy_url = os.environ.get('RESIDENTIAL_PROXY_URL', '')

    if not proxy_url:
        print(
            f"[transcript] No proxy configured, using direct connection for {video_id}")

    last_error = None
    attempts_made = 0

    for attempt in range(MAX_PROXY_RETRIES):
        attempts_made = attempt + 1
        try:
            if proxy_url:
                print(
                    f"[transcript] Attempt {attempt + 1}/{MAX_PROXY_RETRIES} for {video_id}")

            # Always create a fresh instance — rotating proxy gives new IP per connection
            ytt = create_transcript_api(proxy_url)

            # Try English first, then fall back to any language
            transcript = None
            try:
                transcript = ytt.fetch(video_id, languages=["en"])
                lang = "en"
            except Exception as lang_err:
                if "IpBlocked" in type(lang_err).__name__:
                    raise  # re-raise to trigger retry
                transcript = ytt.fetch(video_id)
                lang = "auto"

            if not transcript or not transcript.snippets:
                return {"videoId": video_id, "transcript": None, "error": "No transcript snippets returned"}

            full_text = " ".join(s.text for s in transcript.snippets)
            full_text = " ".join(full_text.split())  # normalize whitespace
            char_count = len(full_text)
            segment_count = len(transcript.snippets)

            print(
                f"[transcript] Success for {video_id} on attempt {attempt + 1}: {char_count} chars, {segment_count} segments, lang={lang}")

            truncated = truncate_at_sentence(full_text, MAX_TRANSCRIPT_CHARS)
            return {
                "videoId": video_id,
                "transcript": truncated,
                "method": "gcf-youtube-transcript-api",
                "lang": lang,
                "originalChars": char_count,
                "segments": segment_count,
            }

        except Exception as e:
            err_type = type(e).__name__
            last_error = e

            if proxy_url and attempt < MAX_PROXY_RETRIES - 1:
                # Retry on ANY error when using proxy (IpBlocked, ProxyError, timeout, etc.)
                # exponential backoff: 1.5, 3, 6, 12s
                delay = RETRY_BASE_DELAY * (2 ** attempt)
                print(
                    f"[transcript] {err_type} for {video_id} on attempt {attempt + 1}, retrying in {delay:.1f}s...")
                time.sleep(delay)
                continue
            else:
                # No proxy or last attempt — stop retrying
                break

    err_type = type(last_error).__name__
    err_msg = str(last_error)
    print(
        f"[transcript] Failed for {video_id} after {attempts_made} attempts: [{err_type}] {err_msg}")
    return {"videoId": video_id, "transcript": None, "error": f"[{err_type}] {err_msg}"}


@functions_framework.http
@billed("fetch-youtube-transcript")
def fetch_youtube_transcript(request):
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        return cors_response(request, '', 204)

    if request.method != 'POST':
        return cors_response(request, {"error": "Method not allowed"}, 405)

    try:
        data = request.get_json(silent=True)
        if not data:
            return cors_response(request, {"error": "Invalid JSON body"}, 400)

        video_ids = data.get("video_ids", [])
        if not video_ids or not isinstance(video_ids, list):
            return cors_response(request, {"error": "Missing or invalid video_ids array"}, 400)

        if len(video_ids) > 5:
            return cors_response(request, {"error": "Maximum 5 videos per request"}, 400)

        print(
            f"Fetching transcripts for {len(video_ids)} video(s): {video_ids}")

        results = []
        for vid in video_ids:
            result = fetch_single_transcript(str(vid).strip())
            results.append(result)

        success_count = sum(1 for r in results if r.get("transcript"))
        print(
            f"Transcript fetch complete: {success_count}/{len(video_ids)} successful")

        return cors_response(request, {
            "success": True,
            "results": results,
            "summary": f"{success_count}/{len(video_ids)} transcripts fetched",
        })

    except Exception as e:
        print(f"Error in fetch-youtube-transcript: {e}")
        return cors_response(request, {"error": str(e)}, 500)
