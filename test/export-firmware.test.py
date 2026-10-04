"""Exercise IDF artifact paths, chip metadata, failure behavior and checksums."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('exporter', Path(__file__).resolve().parents[1] / 'scripts/export-firmware.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTest(unittest.TestCase):
    def test_exports_nested_segments_and_rejects_bad_inputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            build, output = root / 'build', root / 'out'
            build.mkdir()
            metadata = {'flash_files': {'0x0': 'bootloader/bootloader.bin',
                                       '0x8000': 'partition_table/partition-table.bin',
                                       '0x10000': 'espruino.bin'},
                        'extra_esptool_args': {'chip': 'esp32c6'}}
            (build / 'flasher_args.json').write_text(json.dumps(metadata))
            for name in [*metadata['flash_files'].values(), 'flash_args',
                         'merged-binary.bin', 'espruino.elf', 'espruino.map']:
                path = build / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'fixture')
            exporter.export(build, output)
            self.assertEqual((output / 'bootloader/bootloader.bin').read_bytes(), b'fixture')
            self.assertIn('--chip esp32c6', (output / 'FLASH.txt').read_text())
            for line in (output / 'SHA256SUMS').read_text().splitlines():
                digest, path = line.split('  ', 1)
                self.assertEqual(digest, hashlib.sha256((output / path).read_bytes()).hexdigest())
            (build / 'espruino.elf').unlink()
            with self.assertRaises(FileNotFoundError):
                exporter.export(build, root / 'missing')
            self.assertFalse((root / 'missing').exists())
            metadata['flash_files']['0x0'] = '../outside.bin'
            (build / 'flasher_args.json').write_text(json.dumps(metadata))
            with self.assertRaises(ValueError):
                exporter.export(build, root / 'unsafe')
            self.assertFalse((root / 'unsafe').exists())


if __name__ == '__main__':
    unittest.main()
