# Historical client-only ESP32-C6 firmware build

These measurements precede server mode. They do not verify the current server
revision; see SERVER-MODE.md.

Date: 2026-09-27. Result: PASS from a fresh pinned dependency checkout.

- ESP-IDF: v5.5 / 5.5.0.
- Compiler: riscv32-esp-elf GCC 14.2.0, esp-14.2.0_20241119.
- Python: 3.12; component manager: 2.2.2.
- CMake: 3.30.5; Ninja: 1.11.1; esptool: 4.12.0.
- Components: libsodium 1.0.20, mDNS 1.13.1 (see c6-components.lock).
- Application binary: 1,374,416 bytes.
- Merged binary: 1,439,952 bytes, flashed at 0x0.
- App partition: 3,145,728 bytes; board flash configuration: 4 MB; PSRAM off.
- Static D/IRAM: 155,666 bytes used, 296,446 bytes remaining in linker regions.

App SHA-256: `5517ce181d330bd86fb58c7a2f39a50858dfed66db228be91abf857c92b703e6`

Merged SHA-256: `7c4cba8e267dba1a1fe950570d9a32085f6441630691598afb309bf151c9375b`

## What actually ran

The sandbox cannot launch Docker containers. The same firmware build ran
outside Docker with the pinned source fetcher, project patches, ESP-IDF 5.5
and its official C6 toolchain. These commands completed with exit status 0:

```sh
python3 scripts/fetch-deps.py
bash scripts/build-esp32.sh
idf.py -C deps/espruino/bin merge-bin
python3 scripts/export-firmware.py deps/espruino/bin/build /path/to/artifacts
```

Esptool inspection of the app reports valid checksum and validation hash.
The exported flash arguments use bootloader 0x0, partition table 0x8000 and
application 0x10000. Artifact hashes record this validation build; paths and
build metadata can change binary hashes on another machine.

The newer component manager 2.5.2 encountered a process-ID lookup issue in
this sandbox. Version 2.2.2 completed the build and is now pinned in Docker.
No further C6 source fixes were required after the IPv6 and ping patches.

## Limits

The Docker wrapper itself was not executed. No physical board was flashed.
Linker memory figures are not runtime free-heap measurements. C3 and S3 were
not cross-built. The source archive contains build evidence, not prebuilt
firmware or third-party libraries; the Docker build exports your binaries.
