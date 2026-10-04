"""Verify distributables exclude unrelated local files and retain rebuild sources."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('packager', Path(__file__).resolve().parents[1] / 'scripts/package-distribution.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTest(unittest.TestCase):
    def test_packages_allowlisted_firmware_and_source(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / 'project'
            exported = Path(temp) / 'out'
            project.mkdir()
            exported.mkdir()
            for name in packager.SOURCE_PATHS:
                p = project / name
                if name in ['firmware', 'modules', 'native', 'patches', 'scripts', 'examples', 'test', 'docs', 'deps']:
                    p.mkdir()
                else:
                    p.write_text('fixture\n')
            for name in ['docs/RELEASE-BLOCKERS.md', 'deps/espruino/LICENSE',
                         'deps/hyperdht/LICENSE', 'deps/hyperdht/deps/libudx/LICENSE',
                         'deps/hyperdht/deps/libudx/NOTICE',
                         'deps/espruino/bin/managed_components/sodium/LICENSE',
                         'deps/espruino/bin/build/private-output',
                         'deps/espruino/.git/config']:
                p = project / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text('fixture\n')
            metadata = {'extra_esptool_args': {'chip': 'esp32c6'},
                        'flash_settings': {'flash_size': '4MB'}}
            (exported / 'flasher_args.json').write_text(json.dumps(metadata))
            (exported / 'firmware.bin').write_bytes(b'firmware')
            packager.checksums(exported)
            # These files exist beside the export but are not in its manifest.
            (exported / 'board-backup.bin').write_bytes(b'private backup')
            (exported / 'wifi.local.json').write_text('secret credentials')
            with patch.dict('os.environ', {'SOURCE_REVISION': 'a' * 40, 'IDF_PATH': ''}):
                packager.package(exported, project)
            output = exported / 'distribution'
            for archive in output.glob('*.tar.gz'):
                with tarfile.open(archive) as tar:
                    names = tar.getnames()
                    self.assertFalse(any('board-backup' in n or 'wifi.local' in n or '.git/' in n or '/bin/build/' in n for n in names))
                    if '-source.' in archive.name:
                        self.assertTrue(any(n.endswith('/managed_components/sodium/LICENSE') for n in names))
                    else:
                        manifest = next(n for n in names if n.endswith('/BUILD.json'))
                        self.assertEqual(json.load(tar.extractfile(manifest))['project_commit'], 'a' * 40)
            (exported / 'firmware.bin').write_bytes(b'tampered')
            with patch.dict('os.environ', {'SOURCE_REVISION': 'a' * 40}):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    packager.package(exported, project)


    def test_rejects_unvalidated_hardware_profile(self):
        with tempfile.TemporaryDirectory() as temp:
            exported = Path(temp)
            for chip, size in [('esp32c3', '4MB'), ('esp32c6', '2MB')]:
                (exported / 'flasher_args.json').write_text(json.dumps({
                    'extra_esptool_args': {'chip': chip},
                    'flash_settings': {'flash_size': size},
                }))
                with patch.dict('os.environ', {'SOURCE_REVISION': 'local'}):
                    with self.assertRaises(ValueError):
                        packager.package(exported)
                self.assertFalse((exported / 'distribution').exists())


if __name__ == '__main__':
    unittest.main()
