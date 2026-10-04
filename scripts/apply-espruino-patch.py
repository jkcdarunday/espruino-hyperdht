#!/usr/bin/env python3
"""Apply target and networking fixes to the pinned Espruino tree."""
import hashlib, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[1]
esp = pathlib.Path(sys.argv[1]).resolve()
for name, marker_name in [('espruino-c6.patch', '.hyperdht-c6-patch'),
                          ('espruino-dual-stack.patch', '.hyperdht-dual-stack-patch'),
                          ('espruino-wifi-hostname.patch', '.hyperdht-wifi-hostname-patch')]:
    patch = root / 'patches' / name
    marker = esp / marker_name
    digest = hashlib.sha256(patch.read_bytes()).hexdigest()
    if marker.exists():
        if marker.read_text().strip() != digest:
            raise SystemExit(name + ' changed: use a fresh pinned Espruino checkout')
    else:
        subprocess.run(['patch', '--batch', '--forward', '-p1', '-i', str(patch)], cwd=esp, check=True)
        marker.write_text(digest + '\n')
