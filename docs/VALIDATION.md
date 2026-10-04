# Validation record — sensor profile 0.2.0

Date: 2026-09-27. All nine current tests passed in the actual Espruino 2v29
Linux interpreter with the project's C binding, small-profile C++ backend,
static libsodium and ESP32 libuv adapter compiled for its Linux platform.
The peer and private DHT nodes ran original `hyperdht@6.34.0`.

| Test | Result |
| --- | --- |
| Three connections, 32,769 binary bytes each, key identity and write backpressure | PASS |
| Bootstrap timeout and recreate | PASS |
| Single 4 KiB peer frame delivered in chunks of at most 256 bytes | PASS |
| Cancel pending peer discovery and recreate | PASS |
| Twenty active stream abort/recreate cycles | PASS |
| Reject 4097-byte peer frame without delivering application data | PASS |
| Sensor exchange after relayed holepunch RPC negotiation | PASS |
| 64 KiB burst in 1024-byte peer frames, all bytes checked | PASS |
| Corrupted ciphertext MAC rejected before plaintext delivery | PASS |

The holepunch test forces a firewalled peer, disables its LAN address shortcut,
and observes its actual relayed holepunch handler. It exercises the fast-open
path on loopback, not two physical NATs. Only the test peer's interface watcher
is substituted to avoid this environment's netlink restriction. All UDP, DHT,
UDX, Noise and secretstream exchanges are real.

## Native allocation results

| Workload | Peak requested native bytes |
| --- | ---: |
| Repeated small binary exchanges | 28,187 |
| One 4 KiB incoming frame | 35,294 |
| Sensor holepunch exchange | 36,401 |
| 64 KiB burst of small frames | 41,714 |

Every tracked destruction returned to zero live bytes. These are observed host
workloads, not worst-case bounds or total firmware RAM. See `MEMORY.md` for
accounting exclusions. Output is in `test-results-esp32-adapter.txt`.

Reproduce with the prerequisites in the README:

```sh
HYPERDHT_UV_SHIM=1 HYPERDHT_MEMORY_AUDIT=1 ./scripts/build-host.sh
HYPERDHT_STATIC_INTERFACES=1 HYPERDHT_MEMORY_REPORT=1 npm test
```

Outside a netlink-restricted environment, omit `HYPERDHT_STATIC_INTERFACES`.
The audit defaults to a 96 KiB per-process peak gate. Override using
`HYPERDHT_MEMORY_LIMIT` in bytes when intentionally changing the profile.
For nonstandard installations, `SODIUM_LIBRARY` (absolute static archive path)
and `SODIUM_INCLUDE_DIR` can replace pkg-config detection in the shim build.

Also verified: backend patches apply to fresh pinned source archives; C6 patch
applies to the saved unmodified Espruino source files; C6 board/configuration
generation succeeds; Python, shell and example JavaScript syntax checks pass.
The latest profile was tested with the embedded adapter, not desktop libuv.

## C6 cross-build: PASS

Fresh pinned sources pass compilation, linking, image generation, merge-bin
and real artifact export with ESP-IDF 5.5 and C6 GCC 14.2.0. Esptool verifies
the app checksum and validation hash. The IPv6 and ping errors reported in
prior builds are resolved. See C6-BUILD.md, c6-build.log and c6-size.txt.

On 2026-10-04, the current server-capable firmware also passed the Docker
build and physical C6 boot/REPL/native-module checks. The startup crash was
isolated to the backend's thread-local routing RNG and fixed for embedded
builds. A second Espruino hostname-handler crash after DHCP was fixed. With
updated credentials, Wi-Fi and public DHT bootstrap replies pass. Public peer
lookup initially returned `PEER_NOT_FOUND`, despite a working original JavaScript peer.
Free heap was 167,384 bytes before connection setup and 160,732 bytes just
after; peak handshake/transfer memory remains unmeasured. Encrypted board echo
then passed on a controlled original-HyperDHT testnet, including hole-punch
RPC negotiation and three reconnects with every byte value. Disabling Wi-Fi
modem sleep also enabled public discovery, a punch probe and encrypted echo.
The native binding now manages and restores that power setting. Later
production public attempts still failed before the 2026-10-05 fixes below.
The native discovery frontier and relay Noise request reuse now match the
regular JavaScript implementation, with before-fix failing regression fixtures.
The latest host run passes all 19 tests with zero tracked live native bytes
after destruction; see `test-results-connection.txt`.
See `C6-HARDWARE.md`.

## Public acceptance update, 2026-10-05

The production C6 image passes twenty consecutive public encrypted reconnects
with original HyperDHT, checking 1,024 binary bytes per connection. Larger Wi-Fi
buffers, correct routing-query namespaces and cancellation of completed
queries address the reproduced failures. See `C6-HARDWARE.md` for before/after
evidence and limits. The 19-test host run uses shared system libsodium; sodium's
internal allocations are not included in that run's tracker.

## Still unverified

- Physical C6 GPIO and sensor operation.
- Peak handshake/transfer heap, WiFi recovery, watchdog and long-duration stability.
- Reliable physical reconnects and public discovery/connection setup; the latest
  historical testnet run passed four echoes and stalled on the fifth.
  The 2026-10-05 production run passes twenty public reconnects; longer operation
  and additional NAT configurations remain unverified.
- NAT pairings beyond the tested public path and long-duration public connectivity.
- C3/S3 cross-builds and board compatibility.
- Security review of the native backend and changes.

## Hardware checks

Build and flash using the exported FLASH.txt. Verify REPL, native module,
WiFi IPv4 and echo/sensor demos. Measure free/minimum/largest heap blocks and
JS memory throughout bootstrap, holepunching, transfer and destruction. Test
reconnects, packet loss and long operation across real NATs. A successful
cross-build does not establish working-board compatibility.
