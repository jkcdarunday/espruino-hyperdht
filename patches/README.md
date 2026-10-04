# Backend changes

`backend-lifecycle.patch` applies to the exact hyperdht-cpp revision in
`dependencies.json`. `configure.py` applies it once and records its SHA-256.
Changing the patch requires a fresh pinned dependency checkout.

The patch:

1. Makes the ESP32 libuv adapter count only active, referenced handles, rather
   than counting every initialized handle. Stopping timers/prepare handles now
   decrements that count, allowing destruction to finish.
2. Tracks pending outbound connection states by weak reference and cancels their
   queries/raw streams before closing the DHT's RPC socket. This releases a
   pending lookup on client destruction instead of retaining its state cycle.
3. Adds a small C FFI `hyperdht_stream_destroy` function for immediate stream
   abort, used by client destruction. Graceful `close()` remains available.

`configure.py` also adds the already-existing `src/relay_upgrade.cpp` to the
upstream ESP-IDF CMake source list, which omitted it at this revision.

No on-wire packet format, key derivation or encryption algorithm is changed.
The fixes are local; they have not been submitted to or accepted by upstream.

## Sensor profile

`sensor-client.patch` is applied after the lifecycle patch. It enables the
`HYPERDHT_SMALL_CLIENT` option for firmware and the project's host build:

- Bounds routing/query/RPC/NAT caches and disables exposed storage handling.
- Limits encrypted frames to 4 KiB and decrypts in place; invalid MACs close
  the stream with an error instead of suppressing the frame.
- Uses 8 KiB UDX windows and bounds reordered packets before allocating them.
  Pausing advertises a closed receive window; resuming sends a window update.
  The read callback remains active so acknowledged bytes are never discarded.
- Holds early ciphertext until the local header is acknowledged, preventing a
  fast sender from overrunning the pre-connect message queue.
- Deletes the transferred raw-stream handshake context and closes the network
  interface watcher. Fixes the watcher close callback's use-after-free risk.
- Reports transport close errors through the C FFI.
- Keeps this client ephemeral and avoids public bootstrap fallback in private
  NAT sampling. Private holepunch fixtures need enough responsive DHT nodes.

These limits trade throughput and network-search breadth for lower memory use.
They do not change packet encodings or the Noise/secretstream algorithms.

## Experimental C6 port

`espruino-c6.patch` updates the pinned Espruino GPIO, ADC, PWM, SPI, timer and
sleep conditionals for C6, and guards against unsigned heap-reserve underflow. `configure.py` generates the C6 board and IDF setup.
The complete C6 firmware now cross-compiles, links and exports with IDF 5.5.
Physical C6 testing is in progress; C3/S3 cross-builds remain unverified.
All patches retain the license of the upstream files they modify.

`embedded-routing-rng.patch` replaces the backend's thread-local Mersenne
Twister with libsodium's uniform random sampler for embedded builds. ESP-IDF
reserves the roughly 2.5 KiB TLS object in every task stack, exceeding this
firmware's idle stack and corrupting task state before the JavaScript runtime
starts. Desktop builds retain the original generator.

`espruino-wifi-hostname.patch` retains the station interface returned by
ESP-IDF initialization and initializes/checks the hostname lookup before mDNS
startup. The pinned IDF5 handler otherwise passes a null interface and reads
an uninitialized hostname pointer after receiving a DHCP address.

## Dual-stack networking compatibility

`espruino-dual-stack.patch` fixes the IPv4-only `ping_target.addr` assignment
exposed by enabling lwIP IPv6. It uses `ip_addr_copy_from_ip4`, preserving the
IPv4 value and setting the address-family tag without depending on the struct
layout. The DNS callback copies its IPv4 value to a local scalar before passing
it to Espruino's non-const formatting API. This removes the nearby discarded-const
warning without casting away const from lwIP's address. Both changes retain
Espruino's MPL-2.0 license. Existing IPv4 endpoint behavior is unchanged.
