"""Shared billing + runtime-logging helpers for Google Cloud Functions.

Copy this file alongside each GCF's main.py during deploy. Every GCF in
the video pipeline should:

  1. import this module
  2. wrap its entry function with `with billing_session(...) as bs:`
  3. set bs.metadata as it learns more about the work it's doing
  4. on success the session automatically:
       - logs runtime to gcf_runtime_log
       - charges tokens against user_plans + video_tasks.tokens_breakdown

CONSTANTS in this file are MIRRORED from
supabase/functions/_shared/timeEstimates.ts. Keep both in sync.
"""

from __future__ import annotations

import math
import os
import time
import uuid
import contextlib
from datetime import datetime, timezone
from typing import Any, Optional

# ── Per-minute token rates (mirror of TS TOKEN_RATES_PER_MIN) ─────────────
# Calibrated for 40% gross margin at $2 / 1M token sell price
# (i.e. GCP cost <= $1.20 per 1M tokens) → 40% / 52% / 60% margin at
# $2 / $2.50 / $3 per 1M. Tier 1 region pricing (us-central1,
# europe-west1, etc.). If you redeploy with different memory / vCPU,
# recompute as: tokens_per_min = $/min / $1.20 * 1_000_000.
#   create-final-video             16 GiB / 4 vCPU  $0.00816/min
#   create-final-video-high-memory 32 GiB / 8 vCPU  $0.01632/min
#   image-to-video-processor       8 GiB  / 4 vCPU  $0.00696/min
#   calculate-video-durations      8 GiB  / 2 vCPU  $0.00408/min
#   boost-audio-volume             8 GiB  / 2 vCPU  $0.00408/min
#   calculate-audio-duration       4 GiB  / 2 vCPU  $0.00348/min
#   fetch-youtube-transcript       0.5 GiB/ 1 vCPU  $0.001515/min
#   video-concat-function          8 GiB  / 2 vCPU  $0.00408/min
TOKEN_RATES_PER_MIN: dict[str, int] = {
    "calculate-audio-duration":       2900,
    "calculate-video-durations":      3400,
    "boost-audio-volume":             3400,
    "image-to-video-processor":       5800,
    "create-final-video":             6800,
    "create-final-video-high-memory": 13600,
    "fetch-youtube-transcript":       1265,
    "video-concat-function":          3400,
}


def _resolve_base_gcf_name(gcf_name: str) -> str:
    """Strip version suffix from GCF name to look up a rate.

    "create-final-video-high-memory3" -> "create-final-video-high-memory"
    "create-final-video5"             -> "create-final-video"
    "image-to-video-processor2"       -> "image-to-video-processor"
    """
    if gcf_name in TOKEN_RATES_PER_MIN:
        return gcf_name
    # Try removing trailing digits
    stripped = gcf_name.rstrip("0123456789")
    if stripped in TOKEN_RATES_PER_MIN:
        return stripped
    # Try removing trailing -high-memoryN
    if "-high-memory" in stripped:
        base = stripped.split("-high-memory", 1)[0] + "-high-memory"
        if base in TOKEN_RATES_PER_MIN:
            return base
    return gcf_name  # caller will get rate=0 and skip charging


def runtime_to_tokens(gcf_name: str, runtime_seconds: float) -> int:
    base = _resolve_base_gcf_name(gcf_name)
    rate = TOKEN_RATES_PER_MIN.get(base, 0)
    if rate <= 0 or runtime_seconds <= 0:
        return 0
    return int(math.ceil(rate * (runtime_seconds / 60.0)))


def _safe_iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def log_runtime(
    supabase,
    *,
    video_task_id: Optional[str],
    user_id: Optional[str],
    gcf_name: str,
    gcf_version: Optional[str],
    runtime_seconds: float,
    tokens_charged: int,
    started_at: float,
    ended_at: float,
    success: bool,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    """Insert one row into gcf_runtime_log. Never raises."""
    try:
        supabase.table("gcf_runtime_log").insert({
            "id": str(uuid.uuid4()),
            "video_task_id": video_task_id,
            "user_id": user_id,
            "gcf_name": gcf_name,
            "gcf_version": gcf_version or "",
            "runtime_seconds": round(runtime_seconds, 3),
            "tokens_charged": int(tokens_charged),
            "started_at": _safe_iso(started_at),
            "ended_at": _safe_iso(ended_at),
            "success": bool(success),
            "metadata": metadata or {},
        }).execute()
    except Exception as e:
        print(f"[_billing.log_runtime] failed: {e}")


def _check_balance(supabase, user_id: str, tokens_to_add: int) -> int:
    """Return tokens that can safely be charged without exceeding allocation."""
    try:
        result = supabase.table("user_plans").select(
            "tokens_used,tokens_allocated"
        ).eq("user_id", user_id).single().execute()
        if not result.data:
            return 0
        used = result.data.get("tokens_used", 0) or 0
        alloc = result.data.get("tokens_allocated", 0) or 0
        available = max(0, alloc - used)
        return min(tokens_to_add, available)
    except Exception as e:
        print(f"[_billing._check_balance] failed: {e}")
        return 0


# Columns on video_tasks the DB trigger ``video_tasks_tokens_update``
# watches. Each must be a non-decreasing integer; the trigger sums the
# per-column deltas into user_plans.tokens_used.
#
# ``subtitle_tokens_pending`` is also writable here but the trigger does
# NOT watch it — it is the per-chunk accumulator for the chunked subtitle
# burn pipeline. Per-chunk runtime is accumulated there with NO user_plans
# bump; the final concat invocation calls ``finalize_subtitle_tokens()``
# to promote the pending total + its own runtime into ``subtitle_tokens``
# in a single UPDATE so the trigger fires exactly once (clean 0 → X delta).
_VALID_TOKEN_COLUMNS = ("used_tokens", "video_assembly_tokens",
                        "subtitle_tokens", "subtitle_tokens_pending")


def charge_runtime_tokens(
    supabase,
    *,
    user_id: Optional[str],
    video_task_id: Optional[str],
    gcf_name: str,
    runtime_seconds: float,
    tokens_column: str = "used_tokens",
) -> int:
    """Compute tokens for runtime and update video_tasks.<tokens_column>
    + tokens_breakdown. The DB trigger ``video_tasks_tokens_update``
    mirrors the column delta into user_plans.tokens_used, so this
    function must NOT bump user_plans directly (would double-charge).

    ``tokens_column`` controls which column on video_tasks receives the
    increment. Defaults to ``used_tokens``. The subtitle-burn pass uses
    ``subtitle_tokens`` so the charge is a clean 0 → X delta on a
    dedicated column (used_tokens / video_assembly_tokens are already
    populated by earlier pipeline stages).

    If there is no video_task_id we fall back to charging user_plans
    manually, otherwise the user would not be billed at all.

    Returns the number of tokens actually charged. Never raises.
    """
    if not user_id:
        return 0
    if tokens_column not in _VALID_TOKEN_COLUMNS:
        print(f"[_billing] invalid tokens_column {tokens_column!r}, "
              f"falling back to used_tokens")
        tokens_column = "used_tokens"
    tokens_needed = runtime_to_tokens(gcf_name, runtime_seconds)
    if tokens_needed <= 0:
        return 0
    safe_tokens = _check_balance(supabase, user_id, tokens_needed)
    if safe_tokens <= 0:
        print(f"[_billing] no balance for {tokens_needed} tokens ({gcf_name})")
        return 0

    if video_task_id:
        # Update video_tasks.<tokens_column> + tokens_breakdown[gcf_name].
        # The AFTER UPDATE trigger on video_tasks will increment
        # user_plans.tokens_used by the column delta.
        try:
            base = _resolve_base_gcf_name(gcf_name)
            row = supabase.table("video_tasks").select(
                f"tokens_breakdown,{tokens_column}"
            ).eq("id", video_task_id).single().execute()
            data = row.data or {}
            breakdown = data.get("tokens_breakdown") or {}
            if isinstance(breakdown, str):
                # Defensive: in case the column was returned serialized
                import json
                try:
                    breakdown = json.loads(breakdown)
                except Exception:
                    breakdown = {}
            breakdown[base] = int(breakdown.get(base, 0)) + safe_tokens
            cur_tu = int(data.get(tokens_column, 0) or 0)
            supabase.table("video_tasks").update({
                "tokens_breakdown": breakdown,
                tokens_column: cur_tu + safe_tokens,
                "updated_at": "now()",
            }).eq("id", video_task_id).execute()
        except Exception as e:
            print(f"[_billing] video_tasks update failed: {e}")
            return 0
    else:
        # No video_task_id → trigger can't fire. Fall back to manual
        # user_plans increment so the user is still billed.
        try:
            plan = supabase.table("user_plans").select(
                "tokens_used").eq("user_id", user_id).eq(
                "is_active", True).single().execute()
            cur = (plan.data or {}).get("tokens_used", 0) or 0
            supabase.table("user_plans").update({
                "tokens_used": cur + safe_tokens,
                "updated_at": "now()",
            }).eq("user_id", user_id).eq("is_active", True).execute()
        except Exception as e:
            print(f"[_billing] user_plans fallback update failed: {e}")
            return 0

    print(f"[_billing] charged {safe_tokens} tokens for {runtime_seconds:.2f}s "
          f"({gcf_name} → {tokens_column})")
    return safe_tokens


def finalize_subtitle_tokens(
    supabase,
    *,
    user_id: str,
    video_task_id: str,
    gcf_name: str,
    runtime_seconds: float,
) -> int:
    """Concat-step billing for the chunked subtitle pipeline.

    Reads ``subtitle_tokens_pending`` (the running total from per-chunk
    invocations), adds this concat call's own runtime tokens, then in a
    SINGLE UPDATE writes ``subtitle_tokens = total`` and zeroes the
    pending column. The DB trigger sees a clean 0 → total delta on
    ``subtitle_tokens`` and bumps ``user_plans.tokens_used`` exactly
    once.

    Returns the total tokens promoted (pending + concat runtime), or 0 on
    failure / no balance. Never raises.
    """
    if not user_id or not video_task_id:
        return 0
    own_tokens = runtime_to_tokens(gcf_name, runtime_seconds)
    try:
        row = supabase.table("video_tasks").select(
            "subtitle_tokens_pending,subtitle_tokens,tokens_breakdown"
        ).eq("id", video_task_id).single().execute()
        data = row.data or {}
        pending = int(data.get("subtitle_tokens_pending") or 0)
        existing_subs = int(data.get("subtitle_tokens") or 0)
        breakdown = data.get("tokens_breakdown") or {}
        if isinstance(breakdown, str):
            import json
            try:
                breakdown = json.loads(breakdown)
            except Exception:
                breakdown = {}
    except Exception as e:
        print(f"[_billing.finalize_subtitle_tokens] read failed: {e}")
        return 0

    total = pending + own_tokens
    if total <= 0:
        return 0

    safe_total = _check_balance(supabase, user_id, total)
    if safe_total <= 0:
        print(
            f"[_billing.finalize_subtitle_tokens] no balance for {total} tokens")
        return 0

    base = _resolve_base_gcf_name(gcf_name)
    breakdown[base] = int(breakdown.get(base, 0)) + safe_total
    try:
        supabase.table("video_tasks").update({
            "subtitle_tokens": existing_subs + safe_total,
            "subtitle_tokens_pending": 0,
            "tokens_breakdown": breakdown,
            "updated_at": "now()",
        }).eq("id", video_task_id).execute()
    except Exception as e:
        print(f"[_billing.finalize_subtitle_tokens] update failed: {e}")
        return 0

    print(f"[_billing] finalized subtitle tokens: pending={pending} "
          f"+ concat={own_tokens} = {safe_total} → subtitle_tokens")
    return safe_total


# ── Context manager for one GCF invocation ───────────────────────────────
class BillingSession:
    """Mutable context the GCF entry can populate as work proceeds."""

    def __init__(self, gcf_name: str, gcf_version: str = "") -> None:
        self.gcf_name = gcf_name
        self.gcf_version = gcf_version
        self.user_id: Optional[str] = None
        self.video_task_id: Optional[str] = None
        self.metadata: dict[str, Any] = {}
        self.charge: bool = True   # set False to skip user_plans deduction
        self.success: bool = True


def _peek_request_json(request) -> dict:
    """Best-effort, side-effect-free extraction of request JSON body.

    Cloud Functions' request.get_json(silent=True, cache=True) is safe
    to call multiple times — first call caches, later calls reuse.
    """
    try:
        body = request.get_json(silent=True, cache=True) or {}
        if isinstance(body, dict):
            return body
    except Exception:
        pass
    return {}


def _supabase_from_env():
    """Lazy supabase client builder for the decorator path. Returns None
    on any error so we never break the GCF if env vars are missing."""
    try:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SECRET_KEY")
        if not url or not key:
            return None
        from supabase import create_client  # type: ignore
        return create_client(url, key)
    except Exception as e:
        print(f"[_billing] could not build supabase client: {e}")
        return None


# ── Per-request metadata API ─────────────────────────────────────────────
# Decorated functions can call ``add_billing_metadata(request, key=value)``
# at any point during execution. The decorator merges everything stashed
# on ``request._billing_metadata`` into the gcf_runtime_log.metadata column
# in the ``finally`` block, even if the function raises. This lets us
# capture *what work was done* (image counts, audio duration, batch
# ranges, transitions, subtitles) so we can refine the time-estimate
# constants in ``timeEstimates.ts`` from real GCF runtimes.
def add_billing_metadata(request, **kwargs) -> None:
    """Attach key/value pairs to the current GCF invocation's runtime log.

    Safe to call multiple times; later keys overwrite earlier ones with
    the same name. Values must be JSON-serialisable. Never raises (a
    failure here must not break the user-visible response).
    """
    if request is None or not kwargs:
        return
    try:
        existing = getattr(request, "_billing_metadata", None)
        if not isinstance(existing, dict):
            existing = {}
        for k, v in kwargs.items():
            # Drop None values so the metadata stays compact.
            if v is None:
                continue
            existing[k] = v
        # Setting attributes on the Flask request object is supported and
        # scoped to this single invocation.
        try:
            setattr(request, "_billing_metadata", existing)
        except Exception:
            # Some request stand-ins (test doubles) may be read-only.
            pass
    except Exception as e:
        print(f"[_billing.add_billing_metadata] ignored: {e}")


def _collect_metadata(request) -> dict:
    """Return the merged metadata dict for a GCF invocation.

    Always includes the request path (when available) and merges in
    anything the decorated function attached via add_billing_metadata().
    Returns an empty dict on any error so log_runtime never breaks.
    """
    if request is None:
        return {}
    out: dict = {}
    try:
        path = getattr(request, "path", None)
        if path:
            out["path"] = path
    except Exception:
        pass
    try:
        extra = getattr(request, "_billing_metadata", None)
        if isinstance(extra, dict):
            out.update(extra)
    except Exception:
        pass
    return out


def billed(gcf_name: str, gcf_version: str = "", charge: bool = True):
    """Decorator for `@functions_framework.http` entry points.

    Usage:
        @functions_framework.http
        @billed("create-final-video", _GCF_SUFFIX)
        def create_final_video(request):
            ...

    The decorator extracts user_id / video_task_id from the request JSON
    body, runs the entry, then logs runtime to gcf_runtime_log and (if
    charge=True) deducts from user_plans + updates tokens_breakdown.
    Errors propagate; runtime is still logged with success=False.
    """
    def decorator(fn):
        def wrapper(request, *args, **kwargs):
            started_at = time.time()
            start_mono = time.monotonic()
            body = _peek_request_json(request)
            user_id = body.get("user_id") if isinstance(body, dict) else None
            # For batched GCFs (image-to-video-processor) the request carries
            # both the parent ``video_task_id`` (the user-visible task) AND a
            # per-batch ``batch_task_id`` (one row per batch). We bill against
            # the batch row when present so each batch's runtime cost lands on
            # its own row, and the parent row only gets non-batched charges
            # (e.g. calculate-video-durations). Fall back to video_task_id.
            if isinstance(body, dict):
                video_task_id = body.get("batch_task_id") or body.get(
                    "video_task_id")
            else:
                video_task_id = None
            # Subtitle-burn re-entry on create-final-video* routes billing:
            #   • per-chunk invocations  (subtitle_chunk_index set)  →
            #     accumulate into ``subtitle_tokens_pending`` (NOT watched
            #     by the trigger → no user_plans bump yet).
            #   • concat invocation      (subtitle_concat_chunks=true) →
            #     decorator skips its own charge; the function body calls
            #     finalize_subtitle_tokens() to promote pending + concat
            #     runtime into ``subtitle_tokens`` (single trigger fire).
            #   • legacy single-shot burn (burn_subtitles_only, no chunk
            #     index) → charge directly into ``subtitle_tokens``.
            tokens_column = "used_tokens"
            skip_decorator_charge = False
            if isinstance(body, dict):
                if body.get("subtitle_concat_chunks"):
                    skip_decorator_charge = True
                elif body.get("subtitle_chunk_index") is not None:
                    tokens_column = "subtitle_tokens_pending"
                elif body.get("burn_subtitles_only"):
                    tokens_column = "subtitle_tokens"
            ok = True
            response = None
            try:
                response = fn(request, *args, **kwargs)
                return response
            except BaseException:
                ok = False
                raise
            finally:
                runtime_seconds = time.monotonic() - start_mono
                ended_at = time.time()
                supabase = _supabase_from_env()
                tokens = 0
                if supabase is not None:
                    if ok and charge and user_id and not skip_decorator_charge:
                        try:
                            tokens = charge_runtime_tokens(
                                supabase,
                                user_id=user_id,
                                video_task_id=video_task_id,
                                gcf_name=gcf_name,
                                runtime_seconds=runtime_seconds,
                                tokens_column=tokens_column,
                            )
                        except Exception as e:
                            print(
                                f"[_billing] charge in decorator failed: {e}")
                    log_runtime(
                        supabase,
                        video_task_id=video_task_id,
                        user_id=user_id,
                        gcf_name=gcf_name,
                        gcf_version=gcf_version,
                        runtime_seconds=runtime_seconds,
                        tokens_charged=tokens,
                        started_at=started_at,
                        ended_at=ended_at,
                        success=ok,
                        metadata=_collect_metadata(request),
                    )
        wrapper.__wrapped__ = fn  # type: ignore[attr-defined]
        wrapper.__name__ = getattr(fn, "__name__", "billed_wrapper")
        return wrapper
    return decorator


@contextlib.contextmanager
def billing_session(
    supabase,
    gcf_name: str,
    gcf_version: str = "",
):
    """Use as `with billing_session(supabase, "create-final-video", "") as bs:`.

    On normal exit: logs runtime + charges tokens (if bs.charge is True
    and bs.user_id is set).
    On exception: logs runtime with success=False, does NOT charge.
    """
    bs = BillingSession(gcf_name, gcf_version)
    started_at = time.time()
    start_mono = time.monotonic()
    try:
        yield bs
    except BaseException:
        bs.success = False
        raise
    finally:
        runtime_seconds = time.monotonic() - start_mono
        ended_at = time.time()
        tokens = 0
        if bs.success and bs.charge and bs.user_id:
            try:
                tokens = charge_runtime_tokens(
                    supabase,
                    user_id=bs.user_id,
                    video_task_id=bs.video_task_id,
                    gcf_name=bs.gcf_name,
                    runtime_seconds=runtime_seconds,
                )
            except Exception as e:
                print(f"[_billing] charge in finally failed: {e}")
        log_runtime(
            supabase,
            video_task_id=bs.video_task_id,
            user_id=bs.user_id,
            gcf_name=bs.gcf_name,
            gcf_version=bs.gcf_version,
            runtime_seconds=runtime_seconds,
            tokens_charged=tokens,
            started_at=started_at,
            ended_at=ended_at,
            success=bs.success,
            metadata=bs.metadata,
        )
