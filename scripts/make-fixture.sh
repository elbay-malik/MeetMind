#!/usr/bin/env bash
# Generates the synthetic 30s 720p test fixture used by the ffmpeg spike page.
# Requires a native ffmpeg CLI (e.g. `brew install ffmpeg`). Synthetic content
# validates the pipeline (mount, args, progress, output integrity) but is NOT
# a performance datapoint — use a real ~1h meeting recording for that.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p fixtures
ffmpeg -y \
  -f lavfi -i "testsrc=duration=30:size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:duration=30" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 128k -shortest \
  -movflags +faststart fixtures/fixture-30s-720p.mp4

echo "fixture written to fixtures/fixture-30s-720p.mp4"
