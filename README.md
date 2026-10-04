# Espruino HyperDHT for small ESP32 devices

![Agent Built — AI-built](https://img.shields.io/badge/Agent-Built-informational)

A direct HyperDHT client and single-connection server for Espruino. The ESP32 discovers a peer
by its HyperDHT public key, performs the Noise handshake, and sends/receives
bytes over the encrypted UDX stream. There is **no Node.js gateway** between the
ESP32 and its peer. The remote peer uses the original `hyperdht` npm package.

**Readiness:** development snapshot for controlled pilots; not production-ready.
See [release blockers](docs/RELEASE-BLOCKERS.md) before deploying unattended.

**Status:** server mode is host-tested against original HyperDHT, using the
actual Espruino interpreter and ESP32 libuv shim. This revision now builds in
Docker and boots on a physical ESP32-C6 with the native module available.
The board passes encrypted echo and hole-punch negotiation against original
HyperDHT on a testnet. Public encrypted echo passed with Wi-Fi modem sleep
disabled; the native binding now manages that setting during a node’s lifetime. See `docs/C6-HARDWARE.md`.
The latest production C6 run passes twenty public encrypted reconnects after
network-buffer and discovery-lifetime fixes; long-duration stability remains
unverified. Historical client build figures are in `docs/C6-BUILD.md`.
See `docs/SERVER-MODE.md` for this revision's tests and limits.

**Target:** C6 with 4 MB flash and no PSRAM. C3/S3 configurations are provided
but have not been cross-built here. This requires custom Espruino firmware.

## Layout

- `modules/HyperDHT.js`: small Espruino-facing node and stream API.
- `native/`: C binding, polling, bounded buffers and lifecycle management.
- `firmware/`: no-PSRAM sensor settings, C6 pins and 4 MB partition table.
- `patches/`: bounded client profile, lifecycle fixes and experimental C6 port.
- `examples/`: ESP32 client/server and original-HyperDHT controller/echo server.
- `scripts/`: pinned dependency fetch, host/firmware builds and standalone JS bundle.
- `test/interop.test.js`: tests against the original HyperDHT implementation.

## Why native code is needed

HyperDHT uses DHT RPC, Ed25519 Noise IK, UDX, and the secret-stream framing and
ciphers. It is not a normal TCP connection or a few UDP messages. This project
uses Espruino's normal generated native-module mechanism for `HyperDHTNative`.
Application behavior stays in JavaScript. Protocol, cryptography and transport
use the pinned `hyperdht-cpp` implementation, libsodium, and original libudx.

The binding remains small, but it links a C++ protocol backend, libsodium and
libudx. This revision bounds routing/query caches, reduces UDX windows, decrypts
frames in place and fixes teardown leaks. It exposes one connection at a time:
either outbound client mode or an inbound listener restricted to one configured
controller public key. Server mode announces the device's key; it does not
expose DHT storage or relay-server APIs. This is an adapted embedded profile,
not a minimal standalone protocol rewrite. Wire formats and cryptography remain
compatible with the pinned original HyperDHT peer for supported frame sizes.

## Receive commands in server mode

After connecting WiFi and loading the module, provision a private random device
seed and the authorized controller's public key:

```js
var node = new (require("HyperDHT"))({seed: DEVICE_SEED});
node.on("ready", function () { node.listen(CONTROLLER_PUBLIC_KEY); });
node.on("listening", function () { console.log(node.publicKey); });
node.on("connection", function (socket) {
  // Already open; remotePublicKey identifies the authenticated controller.
  socket.on("data", function (chunk) { /* accumulate and parse bounded commands */ });
});
```

Use `examples/esp32-server.js` for bounded, newline-framed commands and
`examples/controller.js` for an original HyperDHT client. The example supports
`status` and `sample` (uptime placeholder; substitute your sensor reading).
`socket.close()` permits the next inbound connection; `node.destroy()` stops
the listener too. Client mode and listening are mutually exclusive on a node.
The controller must wait for each reply before sending another command.

## Get the source

```sh
git clone git@github.com:jkcdarunday/espruino-hyperdht.git
cd espruino-hyperdht
```

## Build the complete firmware with Docker

From this project's root directory, with Docker Buildx installed:

```sh
docker buildx build --progress=plain --output type=local,dest=out .
```

This uses the official `espressif/idf:v5.5` build environment, fetches the pinned
sources, applies the patches, builds Espruino and its native dependencies, and
exports the firmware to `out/`. No host ESP-IDF, Node.js or Python installation
is needed. Internet access to Docker Hub, Ubuntu package repositories, GitHub
and the Espressif component registry is required during the build.

The default chip is **C6**. To select another experimental configuration:

```sh
docker buildx build --build-arg HYPERDHT_CHIP=c3 --output type=local,dest=out-c3 .
docker buildx build --build-arg HYPERDHT_CHIP=s3 --output type=local,dest=out-s3 .
```

The output includes `merged-binary.bin`, app/bootloader/partition binaries,
`espruino.elf`, `espruino.map`, `flash_args`, build configuration, source/component
version records and `SHA256SUMS`. Follow `out/FLASH.txt` to flash; offsets come
from IDF, not hardcoded assumptions. Sensor JS is uploaded separately after
flashing, using `dist/sensor-client.js`; credentials are not embedded in firmware.

The default final Docker stage exports files and is not runnable. For an
interactive environment containing the built project:

```sh
docker build --target builder -t espruino-hyperdht-builder .
docker run --rm -it espruino-hyperdht-builder bash
```

Override `IDF_IMAGE` with a digest-pinned ESP-IDF 5.5 image for immutable base
image selection. Upstream component constraints and OS packages can still
resolve newer compatible versions; their build metadata is exported where
available. `.dockerignore` excludes local dependencies, binaries and output so
previous host builds cannot contaminate the container build.

**Validation:** The Docker firmware build passed with ESP-IDF 5.5, C6 GCC
14.2.0 and component manager 2.2.2. The firmware boots on a physical C6 after
fixing the native backend's oversized thread-local random generator. Wi-Fi and
public DHT bootstrap replies pass. Physical testnet encrypted echo and
hole-punch negotiation pass; see the public connection results and limits in
`docs/C6-HARDWARE.md`.

## Build the ESP32 firmware

Use a dedicated checkout created by the fetch script. Configuration modifies
that checkout; do not point it at an unrelated Espruino working tree.

Prerequisites: git, curl, patch, Python 3.12+, make, and **ESP-IDF 5.5.x** with the
ESP32-C6 RISC-V toolchain installed. Source ESP-IDF's `export.sh` first.

```sh
python3 scripts/fetch-deps.py
./scripts/build-esp32.sh # default: C6, experimental
./scripts/build-esp32.sh flash PORT=/dev/ttyACM0
./scripts/build-esp32.sh monitor PORT=/dev/ttyACM0
```

Set `HYPERDHT_CHIP=c3` or `HYPERDHT_CHIP=s3` for the other board configurations.
All three firmware configurations still require board validation.

The first build downloads the IDF libsodium component. This is a full firmware
flash with a custom partition table; back up existing board contents first.
The build retains the normal Espruino REPL, `Wifi`, GPIO, timers and `Storage`.

If switching between a host build and firmware build in the same dependency
checkout, clean Espruino first (`make -C deps/espruino BOARD=LINUX_HYPERDHT clean`).
Do not reuse a previous ESP32 `bin/sdkconfig` from another board/configuration.

Open the serial REPL at 115200 baud. Verify the native module is present:

```js
require("HyperDHTNative")
```

## Run the original HyperDHT peer

On a computer with Node.js 20+ and outbound UDP access:

```sh
npm ci
npm run sensor
```

Copy the printed `REMOTE_KEY`. The sensor server uses unmodified
`hyperdht@6.34.0` and the normal public network. Leave it running.

Generate the standalone Espruino application:

```sh
npm run bundle
```

Open `dist/sensor-client.js` in the Espruino Web IDE, set `WIFI_SSID`,
`WIFI_PASSWORD`, and `REMOTE_KEY`, then upload it to the custom firmware. It
samples `analogRead(D0)` every ten seconds and sends bounded JSON lines. Adapt
the pin and conversion to your sensor. It keeps only the latest unsent reading,
reconnects with capped backoff and prints small acknowledgements. Set
`ALLOWED_KEY` on the server and provision the client with `new DHT({seed: ...})`
for stable device authentication. The default demo accepts any device key. Set a secret 64-hex-character `SEED`
on the server to retain its identity across restarts.
The original echo demo remains available as `npm run echo` and
`dist/esp32-client.js`.
The bundle includes the JS module, so no module hosting service is required.
For an initial test, upload to RAM. For boot deployment, remove the final
`onInit();` invocation, upload the definitions, then call `save()` while the DHT
is stopped; `onInit` reconnects after reboot. Do not save live native handles.

## Client API

```js
var DHT = require("HyperDHT");
var dht = new DHT();

dht.on("error", function (err) { console.log(err); });
dht.on("ready", function () {
  var socket = dht.connect("YOUR_64_CHARACTER_HEX_PUBLIC_KEY");
  socket.on("open", function () { socket.write("hello\x00\xff"); });
  socket.on("data", function (bytes) { console.log(bytes); });
  socket.on("drain", function () { /* another write is now allowed */ });
  socket.on("close", function () { dht.destroy(); });
});
dht.on("close", function () { console.log("Client fully destroyed"); });
```

`new DHT(options)` accepts:

| Option | Default | Meaning |
| --- | --- | --- |
| `bootstrap` | Public network bootstrap nodes | One `IPv4:port` string for a private network/test |
| `seed` | Random identity | Optional 64-character hex seed for a stable client keypair |
| `bootstrapTimeout` | 180000 | Milliseconds to wait for bootstrap |
| `connectTimeout` | 45000 | Milliseconds to wait for an encrypted connection |

On ESP32, an active native DHT node disables Wi-Fi modem sleep to avoid the
observed UDP send failures. `destroy()` restores the previous power setting.
This uses more radio power while the node is active. Connect Wi-Fi before
constructing the node; allow up to three minutes for public bootstrap.

`dht.publicKey` is a 64-character hex string. The peer key supplied to `connect`
is authenticated by the Noise handshake. A seed is secret: provision it securely
and do not commit it with your application.

Only one DHT instance and one connection are active at a time. Reconnect after
stream `close`; create another DHT after the previous instance's `close` event.
A stream's `close()` is graceful; closing a pending connect destroys the node.
`dht.destroy()` aborts pending/active connections and drains native resources.

All errors are reported on the **DHT object**, not on individual streams.
`open` means the encrypted stream is ready. `data` contains **binary strings**:
characters represent bytes, including NUL. Use `E.toString(uint8Array)` to send
an array; handle UTF-8 explicitly if your application needs Unicode text.

### Flow control and framing

- A write must contain 1..1024 bytes. Only one write is in flight.
- `write(data) === true`: accepted; wait for `drain` before the next write.
- `write(data) === false`: **not accepted**; retry the same data after `drain`.
  This differs from Node's Writable convention, where false still means queued.
- Receive callbacks contain at most 256 bytes. Chunk boundaries do not preserve
  application message boundaries. Use your own length prefix/delimiter.
- The remote peer must limit each encrypted frame to **4096 plaintext bytes**.
  Larger frames fail closed. Prefer separate small `socket.write()` calls; avoid
  batching/corking that merges them into a larger encrypted frame. This is a
  byte-stream API, not a packet/message boundary guarantee.
- Native queued receive data is capped at 4 KiB. Excess input/OOM fails closed
  with an error; it is not silently dropped. The stream is paused while queued
  data is drained into JS. This bounds the binding's buffers, not every internal
  allocation in the third-party protocol stack.
- A 10 ms JS timer pumps native I/O (up to four events per tick). Avoid blocking
  JS loops; this is intended for modest device traffic, not bulk streaming.

## Host interoperability tests

Linux prerequisites: C/C++20 compilers, CMake, make, pkg-config, libsodium
headers/static library, libuv headers/library, Python and Node.js. On Debian-like
systems the packages are `build-essential cmake pkg-config libsodium-dev libuv1-dev`.
Upstream recommends libuv 1.51.x for real NAT deployments; avoid its documented
1.52.0/1.52.1 UDP regression. The ESP32 build uses the embedded adapter instead.

```sh
python3 scripts/fetch-deps.py
npm ci
./scripts/build-host.sh
npm test

# Also exercise the ESP32 libuv adapter's host-compilable implementation:
HYPERDHT_UV_SHIM=1 ./scripts/build-host.sh
npm test
```

The tests start a private local DHT using the original HyperDHT package, then
launch the actual Espruino executable to connect and exchange bytes. They test
binary data, key derivation, backpressure, reconnects, maximum-size frames, oversized-frame rejection,
remote closure, cancellation, timeouts, small-frame bursts and relayed
holepunch RPC negotiation on loopback. They fail if the binary is missing.

In a sandbox without netlink/interface-watcher permission, use
`HYPERDHT_STATIC_INTERFACES=1 npm test`. This passes a real UDX instance through
the original DHT's `udx` option, substituting only a static loopback interface
watcher. UDP packets, DHT discovery, Noise and streams are still real.

## Limits and next validation

There is no topic lookup API, Hypercore replication API,
unordered datagram API, automatic reconnect, or multiple concurrent connections.
NAT traversal is inherited from the backend. The loopback suite checks relayed
holepunch RPCs and encrypted sensor exchange; it does not verify traversal
through physical NATs. Physical C6 testnet echo and public echo results are
recorded in `docs/C6-HARDWARE.md`. A third-party C++ port is
used on-device; its behavioral parity is not identical to the original JS.

Before relying on the board, complete the hardware
checklist in `docs/VALIDATION.md`. Actual ESP32 flash size, free heap, watchdog
behavior, WiFi loss/recovery and long-running public-network connectivity must
be measured on the target. The supplied configuration disables PSRAM. C6 support remains experimental
until physical hardware passes those checks.

## Sources and licensing

Exact source revisions are in `dependencies.json`; npm dependencies are locked.
Upstream code is fetched on build, not hidden inside this source archive.
See `THIRD_PARTY.md` and `patches/README.md`. The original code in this project
is MIT-licensed; third-party licenses apply independently.
