#!/usr/bin/env python3
"""Install binding + dedicated board into our dependency checkout, idempotently."""
import argparse, pathlib, shutil, subprocess, sys
p = argparse.ArgumentParser()
p.add_argument('--espruino', type=pathlib.Path)
p.add_argument('--hyperdht', type=pathlib.Path)
p.add_argument('--host', action='store_true')
p.add_argument('--chip', choices=['c6','c3','s3'], default='c6')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[1]
esp = (a.espruino or root / 'deps/espruino').resolve()
hd = (a.hyperdht or root / 'deps/hyperdht').resolve()
if not (esp / 'Makefile').exists() or not (hd / 'include/hyperdht/hyperdht.h').exists():
    raise SystemExit('Run scripts/fetch-deps.py first')
subprocess.run([sys.executable, str(root / 'scripts/apply-patches.py'), str(hd)], check=True)
target = esp / 'libs/hyperdht'
target.mkdir(exist_ok=True)
for f in (root / 'native').glob('*.[ch]'): shutil.copy2(f, target / f.name)
# Espruino board makefile directives are incorporated before wrapper generation.
common = [
    'WRAPPERSOURCES += libs/hyperdht/jswrap_hyperdht.c',
    'SOURCES += libs/hyperdht/client.c',
    'INCLUDE += -I$(ROOT)/libs/hyperdht',
    'DEFINES += -DHYPERDHT_EMBEDDED=1 -DHYPERDHT_SMALL_CLIENT=1',
]
if a.host:
    board = '''from LINUX import *
from copy import deepcopy
info = deepcopy(info)
info['build']['libraries'] = []
info['build']['makefile'] += %r
info['build']['makefile'] += ['INCLUDE += -I%s/include', 'INCLUDE += $(HDHT_HOST_INCLUDES)', 'DEFINES += $(HDHT_HOST_DEFINES)', 'LIBS += $(HDHT_HOST_LIBS)']
''' % (common, hd.as_posix())
    (esp / 'boards/LINUX_HYPERDHT.py').write_text(board)
    print('Configured LINUX_HYPERDHT')
else:
    subprocess.run([sys.executable, str(root / 'scripts/apply-espruino-patch.py'), str(esp)], check=True)
    part = {'c6':'ESP32C6', 'c3':'ESP32C3', 's3':'ESP32S3'}[a.chip]
    base = 'ESP32S3_IDF5' if a.chip == 's3' else 'ESP32C3_IDF5'
    board = '''from %s import *
from copy import deepcopy
info = deepcopy(info)
chip = deepcopy(chip)
info['name'] = 'Espruino HyperDHT %s sensor client'
info['binary_name'] = 'espruino_sensor.bin'
info['io_buffer_size'] = 1024
info['build']['optimizeflags'] = '-Os'
chip['part'] = '%s'
chip['ram'] = %d
info['variables'] = 4095
info['build']['libraries'] = ['ESP32', 'NET']
info['build']['makefile'] = [s for s in info['build']['makefile'] if not s.startswith('ESP32_FLASH_MAX=') and 'ESP_STACK_SIZE=' not in s and 'ESP_HEAP_SIZE=' not in s]
info['build']['makefile'] += ['ESP32_FLASH_MAX=3145728', 'DEFINES+=-DESP_STACK_SIZE=16384 -DESP_HEAP_SIZE=131072']
info['build']['makefile'] += %r
chip['saved_code']['address'] = 0x320000
chip['saved_code']['flash_available'] = 3072
''' % (base, part, part, 512 if a.chip == 'c6' else 400 if a.chip == 'c3' else 512, common)
    if a.chip == 'c6':
        board += (root / 'firmware/c6-pins.py').read_text()
    (esp / ('boards/' + part + '_HYPERDHT.py')).write_text(board)
    # Register upstream ESP-IDF components, retaining the stock Espruino runtime.
    cmake = esp / 'targets/esp32/IDF5/CMakeLists.txt'
    text = cmake.read_text()
    line = 'set(EXTRA_COMPONENT_DIRS "' + (hd / 'components').as_posix() + '")\n'
    if line not in text: text = text.replace('include($ENV{IDF_PATH}', line + 'include($ENV{IDF_PATH}', 1)
    cmake.write_text(text)
    makefile = esp / 'make/targets/ESP32_IDF5.make'
    text = makefile.read_text()
    if 'ifeq ($(CHIP),ESP32C6)' not in text:
        pos = text.index('ifeq ($(CHIP),ESP32C3)')
        text = text[:pos] + text[pos:].replace('ifeq ($(CHIP),ESP32C3)', 'ifeq ($(CHIP),ESP32C6)\n\tSDKCONFIG = sdkconfig.defaults.esp32c6\n\tFMW_BIN_NAME = espruino-esp32c6\n\tPORT ?= /dev/ttyACM0\nelse ifeq ($(CHIP),ESP32C3)', 1)
    text = text.replace('PUBLIC -Og ', 'PUBLIC -Os ')
    text = text.replace('for d in freertos \\\n', 'for d in hyperdht libuv-esp32 freertos \\\n')
    (esp / 'targets/esp32/IDF5/sdkconfig.defaults.esp32c6').write_text('CONFIG_IDF_TARGET="esp32c6"\nCONFIG_IDF_TARGET_ESP32C6=y\nCONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=y\n')
    # This template serves a dedicated checkout for this project only.
    # Append config last, so Espruino's stock 8MB/Bluetooth settings do not win.
    marker = '\t$(Q)cat ${ROOT}/targets/esp32/IDF5/${SDKCONFIG} >> $(BINDIR)/sdkconfig.defaults\n'
    extra = '\t$(Q)cat ${ROOT}/targets/esp32/IDF5/sdkconfig.hyperdht >> $(BINDIR)/sdkconfig.defaults\n'
    if extra not in text: text = text.replace(marker, marker + extra)
    makefile.write_text(text)
    shutil.copy2(root / 'firmware/sdkconfig.defaults', esp / 'targets/esp32/IDF5/sdkconfig.hyperdht')
    shutil.copy2(root / 'firmware/partitions.csv', esp / 'targets/esp32/IDF5/partitions.csv')
    # Add component-manager dependency where CMake scans for it.
    (hd / 'components/hyperdht/idf_component.yml').write_text('dependencies:\n  espressif/libsodium:\n    version: "1.0.20"\n')
    native_cmake = hd / 'components/hyperdht/CMakeLists.txt'
    text = native_cmake.read_text()
    # Upstream desktop sources include this; its IDF list missed it at the pin.
    anchor = '    "${HDHT_DIR}/src/blind_relay.cpp"\n'
    addition = '    "${HDHT_DIR}/src/relay_upgrade.cpp"\n'
    if addition not in text: text = text.replace(anchor, anchor + addition)
    native_cmake.write_text(text)
    print('Configured ' + part + '_HYPERDHT (4MB flash, no PSRAM; hardware validation required)')
