#!/usr/bin/env python3
"""Apply project patches only to the pinned, dedicated backend checkout."""
import hashlib, pathlib, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[1]
backend = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / 'deps/hyperdht'
for name, marker_name in [('backend-lifecycle.patch', '.espruino-patch'),
                          ('sensor-client.patch', '.espruino-sensor-patch'),
                          ('server-mode.patch', '.espruino-server-patch'),
                          ('server-readiness.patch', '.espruino-server-ready-patch'),
                          ('embedded-routing-rng.patch', '.espruino-routing-rng-patch'),
                          ('query-frontier.patch', '.espruino-query-frontier-patch'),
                          ('shared-handshake.patch', '.espruino-shared-handshake-patch'),
                          ('query-internal.patch', '.espruino-query-internal-patch'),
                          ('query-cancel.patch', '.espruino-query-cancel-patch'),
                          ('connect-query-stop.patch', '.espruino-connect-query-stop-patch')]:
    patch = root / 'patches' / name
    digest = hashlib.sha256(patch.read_bytes()).hexdigest()
    marker = backend / marker_name
    if marker.exists():
        if marker.read_text().strip() != digest:
            raise SystemExit('Patch changed: use a fresh pinned dependency checkout')
    else:
        subprocess.run(['patch', '--batch', '--forward', '-p1', '-i', str(patch)], cwd=backend, check=True)
        marker.write_text(digest + '\n')
