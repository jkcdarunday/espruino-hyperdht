#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
: "${IDF_PATH:?Run through the ESP-IDF image entrypoint}"
cd "$project_dir"
# The Dockerfile already fetched dependencies; this also permits manual reuse.
python3 scripts/fetch-deps.py
bash scripts/build-esp32.sh
# Use IDF's generated offsets/settings, including the chip-specific bootloader.
idf.py -C "$project_dir/deps/espruino/bin" merge-bin
python3 scripts/export-firmware.py "$project_dir/deps/espruino/bin/build" /artifacts
if [[ "${HYPERDHT_CHIP:-c6}" == c6 ]]; then
  python3 scripts/package-distribution.py /artifacts
fi
