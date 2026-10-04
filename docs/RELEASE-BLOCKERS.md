# Snapshot readiness, 2026-10-05

This source snapshot is suitable for controlled pilots, not unattended
production. It preserves the current implementation; the following review
findings have not been fixed.

## Confirmed code issues

| Priority | Finding | Required follow-up |
| --- | --- | --- |
| P1 | Closing a UDP handle in the embedded libuv adapter leaves queued sends without their completion callbacks. The reproduction observed one pending send after the close callback. RPC send contexts release their buffers through those callbacks. | Cancel every queued send with `UV_ECANCELED` before the handle's close callback. Add congestion/abort regression coverage and check allocation cleanup. |
| P1 | Native operations still use throwing C++ allocations, while the firmware disables C++ exceptions. Memory exhaustion can abort and reset the device instead of returning an application error. | Define an allocation-failure strategy and validate it with fault injection and physical low-memory workloads. Fixing retention reduces pressure but does not provide graceful exhaustion handling. |

The UDP reproduction is recorded in `test-results-udp-close-before.txt`.
The affected upstream adapter is
`components/libuv-esp32/src/uv_loop.c` in the pinned backend fetched under
`deps/hyperdht`. Native allocation examples include `src/rpc.cpp` and
`src/query.cpp`. An earlier physical run reset with `std::bad_alloc`; this
predates the final query-lifetime fixes and is not a claim that the final
acceptance run reset.

A separate public host echo leaves 18 tracked bytes at its destruction marker.
Ownership and whether it accumulates across repeated node creation are still
unresolved. The controlled suite returns to zero tracked live bytes. Its audit
uses shared system libsodium and excludes that library's internal allocations;
it is not a measurement of total ESP32 memory.

## What has passed

- All 19 native interoperability/regression tests against original HyperDHT.
- Twenty consecutive public encrypted reconnects on the physical ESP32-C6,
  checking 1,024 bytes containing every byte value per exchange.
- Free heap of 149,844–162,588 bytes at the final run's echo callbacks,
  returning to 196,260 bytes after teardown, with Wi-Fi power saving restored.
- Production cross-build, firmware hash verification and physical flashing.

See `test-results-connection.txt`, `test-results-c6-public.txt`,
`C6-HARDWARE.md` and `VALIDATION.md`. Older build-size records are historical;
the current application is 1,538,768 bytes and its hashes are recorded in
`c6-artifact-checksums.txt`.

## Remaining acceptance work

Run a sustained physical workload with AP outages, reconnects, packet loss,
slow/unresponsive peers and heap-fragmentation monitoring. Measure minimum free
heap and largest allocatable blocks during handshakes, not just echo callbacks.
Validate watchdog behavior, additional NAT combinations and security-sensitive
packet parsing. Board-side server mode, GPIO/sensors and C3/S3 compatibility
remain unverified. Full-chip emulator networking stalled during initialization;
it supplies no substitute for these physical checks.

Host Wi-Fi, NetworkManager and DNS must remain unchanged during board tests:
changing host Wi-Fi can override VPN DNS and break the VPN. Public peer
and serial tests do not require such changes.
