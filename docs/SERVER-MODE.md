# Small server mode

Server mode adds inbound, authenticated, encrypted streams to the existing
sensor profile. It still uses one Espruino module, one native DHT node, and one
application connection. No additional Node.js gateway is required.

## API

After `ready`, call `node.listen(allowedPublicKeyHex)`. The required key is the
controller's Ed25519 public key, not a seed. Provision the device with its own
private random 32-byte seed (64 hex characters) to preserve its public identity.
The controller must retain its separate seed too.

- `listening`: the first DHT announcement cycle has completed with at least one acknowledged record.
- `connection(socket)`: an authorized inbound stream is already open. Install
  data/drain/close listeners here; do not wait for a separate open event.
- `socket.remotePublicKey`: authenticated remote key, lowercase hex.
- `socket.write(binaryString)`: at most 1024 bytes; true means accepted.
  False means not accepted: retry after drain.
- `socket.close()`: close this stream, retaining the listener.
- `node.destroy()`: destroy stream, listener and DHT. Wait for node close
  before creating another node.

A node cannot listen and initiate outbound connections simultaneously.
There is no dynamic authorization list: recreate the node to change the
allowed controller. There is no relay-server or arbitrary storage API.
Native teardown force-closes the announcer; published discovery records can
remain until their network expiration. They cannot accept new connections.

## Bounds and behavior

The binding authorizes only the configured key and rejects a second connection
while occupied. The embedded backend allows one pending handshake, with a
bounded duplicate-reply queue and pruning of stale handshake entries.
Rejected identities are not retained as pending sessions. An incomplete
authorized handshake can temporarily occupy the pending slot until cleanup.

Existing limits remain: 4096-byte maximum plaintext frame, 4096-byte bridge
receive budget, eight bridge events, 256-byte JS receive chunks, one write
in flight. The 128-byte example command parser is separately bounded.
Packets may split or combine application data; parse framing explicitly.

Listening requires WiFi/UDP connectivity and periodic DHT announcements.
A sleeping device is unavailable until it wakes, reconnects and announces.
NAT traversal is supported by the protocol but is not guaranteed for every
NAT pairing; the small profile does not provide unrestricted birthday
punching or relay fallback. Physical NAT and long-running board testing remain
necessary.

## Verification (2026-09-28)

Built the actual Espruino Linux interpreter with this native binding, pinned
C++ backend, ESP32 libuv shim, and allocation profiler. Tested against original
npm HyperDHT 6.34.0 over real loopback UDP, using the static interface-watcher
fixture for this environment:

```sh
HYPERDHT_UV_SHIM=1 HYPERDHT_MEMORY_AUDIT=1 bash scripts/build-host.sh
HYPERDHT_STATIC_INTERFACES=1 HYPERDHT_MEMORY_REPORT=1 npm test
```

14 tests passed: nine existing client tests plus inbound command exchange over
three connections, unauthorized/busy peer rejection probes, repeated listener
destroy/recreate, teardown with an active inbound stream, and cancellation before listener readiness. The inbound
exchange test disables the local-address shortcut and asserts that original
HyperDHT issues holepunch RPCs. This is protocol negotiation on loopback, not
a test of a physical NAT.

Server cases peaked below 28 KiB tracked native requested heap, with zero
tracked bytes remaining after destruction. The full suite stayed below the
96 KiB native-heap test ceiling. These numbers exclude interpreter memory,
WiFi, RTOS, stack, and allocator overhead. They are not total device RAM usage.

The listening event waits for acknowledged announcements, fixing an upstream
startup race where a controller could otherwise see PEER_NOT_FOUND.

This revision now cross-builds in Docker and boots on a physical C6. Wi-Fi and
public DHT bootstrap replies pass after startup and hostname fixes. Public
client echo and hole-punch negotiation have passed against original HyperDHT
on a testnet. Public encrypted client echo passed with Wi-Fi modem sleep disabled;
the binding now controls/restores that setting automatically. See
C6-HARDWARE.md. The 2026-10-05 production client passes twenty public
reconnects after network-buffer and discovery-lifetime fixes. Board-side
server mode has not yet been physically verified.
The prior client-only build remains recorded in C6-BUILD.md; its binary sizes
and hashes do not apply to this revision.
