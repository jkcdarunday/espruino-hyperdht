# ESP32-C6 physical test, 2026-10-04

Hardware: ESP32-C6FH4 revision v0.2, embedded 4 MB flash, no PSRAM,
USB serial/JTAG on `/dev/ttyACM1`. The original full flash was backed up in
`out/board-backup-REDACTED_DEVICE-20261004.bin` before flashing.

The current firmware built with Docker, ESP-IDF 5.5 and component manager
2.2.2. Esptool 5.3.1 flashed and verified the bootloader, partition table and
application. The application size is 1,538,768 bytes.

## Startup failure and fix

The native-enabled image crashed in FreeRTOS's first context switch, before
`app_main`. A control image built without the HyperDHT binding/backend booted
to the Espruino REPL. Instrumenting task creation showed the main task's
ready-list owner pointer becoming zero during creation of the idle task.

The backend's `RoutingTable::random()` declared a thread-local `std::mt19937`.
Its RNG and initialization guard contributed 2,508 bytes to `.flash.tbss`.
ESP-IDF allocates that TLS area inside every task stack, including the idle
task's 1,536-byte stack. Initialization overwrote neighboring task state.

`patches/embedded-routing-rng.patch` uses libsodium `randombytes_uniform()`
for embedded builds and retains the original desktop generator. The backend
already uses libsodium random samplers elsewhere. The fixed image has zero
bytes in `.flash.tbss`, boots and exposes `HyperDHTNative.start` as a function.
Increasing the interrupt stack did not fix the problem and was reverted.
ESP-IDF assertions and informational logging are enabled for validation.

Confirmed through the REPL: Espruino 2v29, `ESP32C6_HYPERDHT`, built-in
`HyperDHTNative`, loading the JavaScript `HyperDHT` module into its cache, and
a JavaScript timer callback.

A second crash appeared after DHCP association. The decoded fault was in
Espruino's `wifi_event_handler`, dereferencing the hostname at line 530.
The pinned IDF5 code discarded the station interface returned by creation,
passed the resulting null handle to hostname lookup, ignored its failure and
read an uninitialized pointer. `espruino-wifi-hostname.patch` retains the
interface, initializes the hostname pointer and checks the lookup result.
The rebuilt/flashed image then associated and entered the Wi-Fi callback.

## Connection failures and mitigations

Wi-Fi association and DHCP were successful on the board (`[REDACTED_IP]`),
but a public peer lookup returned `PEER_NOT_FOUND`. Original `hyperdht@6.34.0`
clients independently found the same advertised server and completed echoes.
The backend can emit `ready` after zero replies, so diagnostic bootstrap reply
counts were checked separately rather than relying on that event alone.

A testnet initially bound to the host's wired address (`[REDACTED_IP]`) was not
reachable from the board's Wi-Fi subnet. Temporarily joining the host's unused
Wi-Fi adapter produced the directly reachable address `[REDACTED_IP]`.
Original-JavaScript testnet discovery, Noise, encrypted echo and hole-punch RPC
negotiation then succeeded on the ESP32. The server was forced firewalled with
LAN shortcut addresses disabled. This isolates protocol operation; a LAN
fixture alone does not establish traversal through physical NATs.

Instrumenting `uv_udp_try_send`, rather than libudx's callback, exposed the
public failure: after several bootstrap replies, `sendmsg` repeatedly failed
with errno -1 and later ENOMEM despite roughly 190 KiB of free heap. In the
pinned lwIP error table, -1 corresponds to `ERR_IF` (a low-level interface
error). Libudx suppresses fast-path send errors, so discovery eventually
reported the misleading `PEER_NOT_FOUND` outcome.

An otherwise equivalent attempt with Wi-Fi power saving disabled received
15 successful bootstrap replies, discovered the announced peer, received a
punch probe from its public address and completed an encrypted binary echo.
This identifies a working mitigation for this board/network/configuration;
it does not establish a general ESP-IDF modem-sleep defect. See
`out/c6-public-echo-nosleep.log`.

`native/client.c` now saves the ESP32 Wi-Fi power mode and selects
`WIFI_PS_NONE` while a native DHT node is active. Completed asynchronous
teardown and interpreter shutdown restore the previous mode. This increases
radio power use while HyperDHT is active. The bounded embedded bootstrap walk
can exceed 45 seconds on the public network, so the JavaScript module's default
bootstrap deadline is now 180 seconds. The connection deadline remains
45 seconds; both are configurable.

An earlier production run passed three consecutive connections against the
six-node original-HyperDHT testnet. Each exchanged 1,024 bytes containing all
256 byte values. The peer recorded five hole-punch RPCs across those three
connections. Hardware output confirmed `min_modem` before construction,
`none` while active and restoration to `min_modem` after node destruction.
See `out/c6-fixed-testnet.log`.

## Announcement timing crosscheck

Original HyperDHT `server.listen()` awaits the announcer's initial update
before emitting `listening` or resolving. Its client walks `findPeer` and
returns `PEER_NOT_FOUND` when no record is found; it does not wait indefinitely
for a server to appear. On the controlled network, an original client failed
before announcement in 1 ms, then found three records and completed an echo
in 10 ms after `await server.listen()` with the same client.

Announce first, then connect. In the failing public tests, advertisement had
already been confirmed through three original-JavaScript `findPeer` replies,
so announcement order does not explain those failures.

## Native discovery and relay differences

The native small profile allowed irrelevant referrals to consume its entire
128-entry discovery budget before rejecting them as too far from the target.
`query-frontier.patch` filters before insertion, matching regular dht-rpc.
A real UDP fixture fills the nearest set, returns 150 irrelevant referrals
followed by a useful record holder, and verifies discovery reaches that holder.
The unpatched backend fails; the patched backend passes.

Regular HyperDHT memoizes one encrypted Noise request across relay attempts.
The native backend instead generated a fresh initiator per relay, allowing
multiple server sessions with different keys for one client UDX stream ID.
`shared-handshake.patch` shares the request across relay and cached-route
attempts. Each reply is validated from a copy of the post-request state so
an invalid reply cannot poison another attempt. A delayed-relay regression
observed two distinct requests before the fix; afterward the same requests
produce one server session and a successful encrypted echo.

All 19 host interoperability tests pass with the ESP32 libuv adapter and
allocation audit. Every recorded destruction returns tracked live bytes to
zero. See `test-results-connection.txt` and the corresponding before-fix logs.

Public reliability is still under investigation. The power-mode mitigation
produced one diagnostic public echo, but subsequent production attempts failed
discovery or connection setup. A regular JavaScript client bound to the host's
Wi-Fi address, routed through the board's gateway, found three advertised
records and completed an echo. Thus announcement order and the Wi-Fi gateway
alone do not explain the native public failures. After the discovery fix,
a hardware testnet run completed two binary echoes and failed holepunching
on its third connection; this motivated the shared-handshake regression.

The rebuilt production firmware with the shared handshake passed four
consecutive 1,024-byte encrypted testnet echoes. The fifth connection reached
the regular server but timed out before the board stream opened. The power
setting was restored after failure. This fixes the reproduced duplicate
handshake/session bug but does not establish reliable hardware reconnects.
See `out/c6-shared-handshake-testnet.log`. A final public attempt with this
production image still returned `PEER_NOT_FOUND`; see
`out/c6-shared-handshake-public.log`.

## Public reconnect fixes, 2026-10-05

`query-internal.patch` preserves the internal namespace on routing queries.
Without it, bootstrap sent external command 2 (FIND_PEER) instead of internal
command 2 (FIND_NODE). A wire-level regression fails before the fix and passes
with it. This correction alone did not resolve physical discovery failures.

The original Wi-Fi profile (4 static RX, 8 dynamic RX/TX, UDP mailbox 8)
stopped receiving UDP replies partway through bootstrap. Disabling the board's
soft AP alone still failed. Increasing those settings to 8 static RX,
32 dynamic RX/TX and UDP mailbox 16 completed three public encrypted echoes.
These changes increase the platform memory budget outside the native audit.
The observations identify a working configuration; they do not establish
which individual buffer limit caused the stall.

A longer run then reset after eight echoes. Decoding the firmware's stack
identified `std::bad_alloc` while creating a discovery callback.
`query-cancel.patch` tracks and cancels unfinished walk requests at query
completion, releasing callbacks that retained the discovery frontier. The
regression observes six packets to silent peers before the fix and only the
two initial requests afterward. `connect-query-stop.patch` also destroys the
walk after a successful handshake instead of only dropping its owner pointer.

Production firmware with query cancellation and the larger buffers completed
twenty consecutive public encrypted echoes, each checking all 256 byte values
in a 1,024-byte payload. Wi-Fi power saving returned to its original mode.
After the final handshake cleanup, the repeated twenty-connection run kept
149,844–162,588 bytes free at echo callbacks and returned to 196,260 bytes
after teardown. The filtered publishable record is
[`test-results-c6-public.txt`](test-results-c6-public.txt); the complete local log
is `out/c6-production-public-twenty.log`. This is a bounded acceptance run,
not evidence of long-duration stability or all possible NAT pairings.

The current host suite passes 19 tests, including twenty firewalled-peer
reconnects, wire namespace and early-query cancellation regressions. This
run links the system shared libsodium; its internal allocations are excluded
from the native tracker. Tracked destruction returns to zero live bytes.
See `test-results-connection.txt` and the before-fix fixtures. A separate
public host echo also passes; its audit reports 18 tracked bytes remaining
at the destruction marker, whose ownership remains unresolved. The zero-live
result above applies to the controlled suite, not that public run.

## Emulation and host networking

Linux emulation executes the actual Espruino interpreter, native binding and
ESP32 libuv adapter over real UDP, but does not emulate FreeRTOS or the radio.
The official [ESP emulator](https://github.com/espressif/esp-emulator) beta
0.45.0 was also tried with the production merged C6 image and user-mode
networking. It booted ESP-IDF/FreeRTOS but stopped progressing during Wi-Fi
initialization. Full-firmware networking validation remains unavailable in
this emulator configuration; physical tests supply the acceptance evidence.

Keep host NetworkManager connections and DNS unchanged during board tests.
Changing host Wi-Fi can replace the VPN's DNS and break the VPN. Public tests
need no host Wi-Fi change; emulator user-mode networking needs no new adapter.
Use the serial harness to connect only the board to its configured access point.

## Reproduce the board test

Run the host on an IPv4 address reachable from the board. A private testnet
needs that route; the public HyperDHT deployment does not require a shared LAN.
The script uses six bootstrap ports starting at the supplied base port, plus
an ephemeral server socket. It verifies advertisement before printing the key.

```sh
node scripts/testnet-echo.js HOST_IPV4 52738
python scripts/test-hardware.py --port /dev/ttyACM1 \
  --wifi /tmp/hyperdht-wifi.json --bootstrap HOST_IPV4:52738 \
  --key PRINTED_REMOTE_KEY --log out/c6-hardware-echo.log
```

The hardware script requires Python's `serial` module, loads
`modules/HyperDHT.js` and the test into RAM, paces serial uploads and redacts
credentials from saved/output logs. It tests three binary echoes by default
and checks restoration of the Wi-Fi power mode. Omit `--bootstrap` to use the
public DHT and provide an already-listening public echo server's key. Stop the
host testnet with Ctrl-C. No credentials or application code are saved to flash.

## Related upstream reports

No matching report for this routing RNG startup failure was found in the
issue search. Related reports have different signatures:

- [Espruino #2731](https://github.com/espruino/Espruino/issues/2731): IDF5
  integration tracking, including Wi-Fi event handling, power and Bluetooth.
- [ESP-IDF #15475](https://github.com/espressif/esp-idf/issues/15475): an
  intermittent C6 startup failure, rather than this reproducible TLS overwrite.
- [ESP-IDF TLS documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c6/api-guides/thread-local-storage.html)
  explicitly states that the complete static TLS area is reserved in every
  task's stack, even when the task does not use those variables.

GPIO, sensor operation, peak connection memory, NAT pairings beyond the tested
path and long-duration stability remain unverified.
