# Sensor profile memory

The old 8 MB PSRAM recommendation was not a measured client requirement.
The new firmware configuration uses 4 MB flash and disables PSRAM. That is a
build target. The C6 binary now links and fits its partition, but total runtime
RAM still requires measurement on hardware.

## Bounded working sets

| Resource | Sensor profile |
| --- | ---: |
| DHT instances / outgoing streams | 1 / 1 |
| Application write in flight | 1, at most 1024 bytes |
| Native receive queue / JS read chunk | 4096 / 256 bytes |
| Maximum decrypted peer frame | 4096 bytes |
| Ciphertext backlog cap | 16 KiB |
| UDX send/receive window | 8 KiB each |
| UDX reordered packet count / sequence distance | 16 / 32 |
| Query concurrency / RPC window | 3 / 4 |
| Query seen set / routing nodes | 128 / 32 |
| RPC pending queue / RTT cache | 16 / 32 |
| Delayed pings / NAT sample history | 2 / 32 |
| Configured Espruino task stack | 16 KiB |
| Heap reserve before sizing Espruino JS variables | 128 KiB |

These values are not additive total RAM consumption: some describe windows,
others queue limits or dynamically allocated capacity. C++ vector capacity,
allocator metadata, packet state and timers add overhead. Peak usage changes
with node count, loss, reordering and NAT behavior. Allocation failure in the
third-party C++ backend is not universally recoverable.

## Measurement method

`HYPERDHT_MEMORY_AUDIT=1 HYPERDHT_UV_SHIM=1 ./scripts/build-host.sh` builds a
host-only allocation tracker. `HYPERDHT_MEMORY_REPORT=1 npm test` checks a
96 KiB native peak ceiling per child process and zero tracked live bytes after
each destruction. Static libsodium and the embedded libuv adapter are included;
tracker metadata itself is excluded. The tracker is never linked into firmware.

The audit records malloc/calloc/realloc and C++ new while executing native DHT
operations and tracks their frees. This is **native requested heap on a 64-bit
Linux host**, not whole-process RSS or ESP32 free-heap instrumentation. It
excludes Espruino's JS arena, WiFi/lwIP, FreeRTOS stacks, allocator overhead and
platform initialization. Results cannot establish a board's total RAM budget.
See the validation record and captured test output for current peaks.

The prior profile measured 42,044 bytes peak for the binary exchange and
295,198 bytes for a single 64 KiB peer frame. The latter is intentionally no
longer supported. Sensor traffic should use small frames, not bulk frames.

## IPv6 build dependency

The pinned libuv adapter and libudx require lwIP's IPv6 types even for this
IPv4 client. Firmware therefore enables CONFIG_LWIP_IPV6, with SLAAC and
forwarding disabled. This adds platform memory outside the host native audit;
measure it as part of total firmware RAM. A true IPv4-only backend would need
consistent source guards across these libraries, not fabricated socket types.

## Hardware acceptance

Cross-build and inspect the map/app size first. On the target measure free heap,
minimum free heap and largest free block before WiFi, after WiFi, after DHT
bootstrap, during hole punching, during transfer and after destruction. Run
repeated reconnects and a sustained sensor workload, including packet loss.
Also check JS memory with `process.memory()`; it does not report native heap.
Retain margin for WiFi bursts and fragmented allocations. Tune the 128 KiB
reserve only from these measurements, not from the host-only peak.

The successful C6 link reports 155,666 bytes of static D/IRAM usage and
296,446 bytes remaining in those regions. This includes IRAM code and is not
runtime free heap. See C6-BUILD.md and c6-size.txt.
