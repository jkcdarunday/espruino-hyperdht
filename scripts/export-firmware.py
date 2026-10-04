#!/usr/bin/env python3
"""Export a successful IDF build without guessing binary names or offsets."""
import hashlib
import json
from pathlib import Path
import shutil
import sys


def export(build, output):
    build, output = Path(build).resolve(), Path(output).resolve()
    metadata = json.loads((build / 'flasher_args.json').read_text())
    chip = metadata.get('extra_esptool_args', {}).get('chip')
    if chip not in ('esp32c6', 'esp32c3', 'esp32s3'):
        raise ValueError('Missing or unexpected chip in flasher_args.json')
    files = list(metadata['flash_files'].values())
    files += ['flash_args', 'flasher_args.json', 'merged-binary.bin',
              'espruino.elf', 'espruino.map']
    # Check every input before creating an apparently successful export.
    for name in files:
        path = Path(name)
        source = (build / path).resolve()
        if path.is_absolute() or '..' in path.parts or not source.is_relative_to(build):
            raise ValueError('Unexpected non-local artifact path: ' + name)
        if not source.is_file():
            raise FileNotFoundError(source)
    output.mkdir(parents=True, exist_ok=True)
    for name in files:
        dest = output / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(build / name, dest)
    project = Path(__file__).resolve().parents[1]
    shutil.copy2(project / 'dependencies.json', output / 'source-revisions.json')
    # Preserve IDF's resolved component versions and configuration when available.
    for source, name in [(build.parent / 'dependencies.lock', 'components.lock'),
                         (build.parent / 'sdkconfig', 'sdkconfig')]:
        if source.is_file():
            shutil.copy2(source, output / name)
    (output / 'FLASH.txt').write_text(
        'Run from this directory with esptool installed:\n\n'
        f'python -m esptool --chip {chip} --port PORT write_flash @flash_args\n\n'
        'Replace PORT with the serial device. Alternatively, the merged image\n'
        'contains these same segments and is flashed at address 0x0.\n'
        'This changes the partition layout; back up existing board contents.\n'
        'A successful build does not establish hardware/NAT compatibility.\n')
    paths = sorted(p for p in output.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
    (output / 'SHA256SUMS').write_text(''.join(
        hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(output).as_posix() + '\n'
        for p in paths))
    print('Exported firmware to', output)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: export-firmware.py IDF_BUILD_DIR OUTPUT_DIR')
    export(sys.argv[1], sys.argv[2])
