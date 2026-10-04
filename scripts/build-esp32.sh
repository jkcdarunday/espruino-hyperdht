#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
: "${IDF_PATH:?Source ESP-IDF 5.5 export.sh first}"
chip="${HYPERDHT_CHIP:-c6}"
case "$chip" in
  c6) target=esp32c6; board=ESP32C6_HYPERDHT ;;
  c3) target=esp32c3; board=ESP32C3_HYPERDHT ;;
  s3) target=esp32s3; board=ESP32S3_HYPERDHT ;;
  *) echo 'HYPERDHT_CHIP must be c6, c3, or s3' >&2; exit 1 ;;
esac
python3 "$project_dir/scripts/configure.py" --chip "$chip"
cd "$project_dir/deps/espruino"
IDF_TARGET="$target" BOARD="$board" RELEASE=1 make "$@"
