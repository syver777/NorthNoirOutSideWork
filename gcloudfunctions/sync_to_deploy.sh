#!/usr/bin/env bash
set -euo pipefail

SRC="/Users/syver-augustmeyer/Desktop/NorthNoir/gcloudfunctions"
DST="/Users/syver-augustmeyer/Desktop/SSAIGoogleCloud"

# Numbered GCF families: source file is "<name>.py" in $SRC, deploy
# folder is "$DST/<name>" with main.py.
CFV_NAMES=(
  "create-final-video"
  "create-final-video2"
  "create-final-video3"
  "create-final-video4"
  "create-final-video5"
  "create-final-video-high-memory"
  "create-final-video-high-memory2"
  "create-final-video-high-memory3"
  "create-final-video-high-memory4"
  "create-final-video-high-memory5"
)

CVD_NAMES=(
  "calculate-video-durations"
  "calculate-video-durations2"
  "calculate-video-durations3"
  "calculate-video-durations4"
  "calculate-video-durations5"
)

ITV_NAMES=(
  "image-to-video-processor"
  "image-to-video-processor2"
  "image-to-video-processor3"
  "image-to-video-processor4"
  "image-to-video-processor5"
)

# Single-folder GCFs that also import from _billing.
SINGLE_NAMES=(
  "boost-audio-volume"
  "calculate-audio-duration"
  "fetch-youtube-transcript"
)

copy_billing() {
  local d="$1"
  cp "$SRC/_billing.py" "$d/_billing.py"
  echo "  BIL   _billing.py -> $(basename "$d")"
}

echo "==> Syncing create-final-video* ..."
for name in "${CFV_NAMES[@]}"; do
  d="$DST/$name"
  if [ ! -d "$d" ]; then
    echo "  SKIP  $name (folder missing)"
    continue
  fi
  cp "$SRC/${name}.py"   "$d/main.py"
  cp "$SRC/subtitles.py" "$d/subtitles.py"
  rm -rf "$d/fonts"
  cp -R "$SRC/fonts"     "$d/fonts"
  copy_billing "$d"

  if ! grep -q '^fal-client' "$d/requirements.txt"; then
    # Ensure trailing newline before appending so we don't glue lines together
    [ -s "$d/requirements.txt" ] && [ "$(tail -c1 "$d/requirements.txt")" != "" ] && printf '\n' >> "$d/requirements.txt"
    echo "fal-client==0.7.0" >> "$d/requirements.txt"
    echo "  ADD   fal-client to $name/requirements.txt"
  fi
  echo "  OK    $name"
done

echo
echo "==> Syncing calculate-video-durations* ..."
for name in "${CVD_NAMES[@]}"; do
  d="$DST/$name"
  if [ ! -d "$d" ]; then
    echo "  SKIP  $name (folder missing)"
    continue
  fi
  cp "$SRC/${name}.py" "$d/main.py"
  copy_billing "$d"
  echo "  OK    $name"
done

echo
echo "==> Syncing image-to-video-processor* ..."
for name in "${ITV_NAMES[@]}"; do
  d="$DST/$name"
  if [ ! -d "$d" ]; then
    echo "  SKIP  $name (folder missing)"
    continue
  fi
  cp "$SRC/${name}.py" "$d/main.py"
  copy_billing "$d"
  echo "  OK    $name"
done

echo
echo "==> Syncing single-folder GCFs ..."
for name in "${SINGLE_NAMES[@]}"; do
  d="$DST/$name"
  if [ ! -d "$d" ]; then
    echo "  SKIP  $name (folder missing)"
    continue
  fi
  cp "$SRC/${name}.py" "$d/main.py"
  copy_billing "$d"
  echo "  OK    $name"
done

echo
echo "==> Done."
