# Third-party dependencies

| Component | Source | License |
| --- | --- | --- |
| Espruino | https://github.com/espruino/Espruino | MPL-2.0 |
| hyperdht-cpp | https://github.com/jjacke13/hyperdht-cpp | LGPL-3.0 |
| libudx | https://github.com/holepunchto/libudx | Apache-2.0 |
| libsodium | https://github.com/jedisct1/libsodium | ISC |
| libuv (host tests) | https://github.com/libuv/libuv | MIT plus bundled notices |
| HyperDHT (reference tests/server) | https://github.com/holepunchto/hyperdht | MIT |
| ESP-IDF | https://github.com/espressif/esp-idf | Apache-2.0 plus component notices |

The backend sources, including its ESP32 libuv adapter, retain their upstream
licenses. The patch to those sources is provided under the same terms as the
files it modifies. Preserve their LICENSE/NOTICE files when redistributing
combined source or firmware. The complete source-build recipe is included;
any binary redistribution must also address the backend's LGPL requirements,
including the required ability to relink with a modified library.

The Git repository does not vendor third-party libraries or include generated
native executables, WiFi credentials or private keys. CI distributables include
firmware plus a separate source archive containing the patched pinned libraries
and the build recipe. Firmware archives include third-party license notices. The included npm lockfile records
additional transitive reference-peer dependencies.
