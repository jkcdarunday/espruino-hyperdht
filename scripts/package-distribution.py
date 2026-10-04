#!/usr/bin/env python3
"""Package verified firmware and rebuildable source; never copy arbitrary out files."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

PROJECT = Path(__file__).resolve().parents[1]
SOURCE_PATHS = ['Dockerfile', '.dockerignore', 'LICENSE', 'THIRD_PARTY.md',
                'README.md', 'dependencies.json', 'package.json', 'package-lock.json',
                'firmware', 'modules', 'native', 'patches', 'scripts', 'examples',
                'test', 'docs', 'deps']


def checksums(folder):
    paths = sorted(p for p in folder.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
    (folder / 'SHA256SUMS').write_text(''.join(
        hashlib.sha256(p.read_bytes()).hexdigest() + '  ' +
        p.relative_to(folder).as_posix() + '\n' for p in paths))


def source_filter(info):
    # Archive paths include the top-level source directory.
    parts = Path(info.name).parts[1:]
    if any(p in ('.git', '__pycache__', 'node_modules') for p in parts):
        return None
    if parts[:3] == ('deps', 'espruino', 'bin'):
        # Keep downloaded component sources, not build outputs or executables.
        if len(parts) > 3 and parts[3] != 'managed_components':
            return None
    if info.name.endswith(('.pyc', '.pyo')):
        return None
    return info


def package(exported, project=PROJECT):
    exported, project = Path(exported).resolve(), Path(project).resolve()
    revision = os.environ.get('SOURCE_REVISION', 'local')
    if revision != 'local' and not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('SOURCE_REVISION must be a full commit SHA')
    metadata = json.loads((exported / 'flasher_args.json').read_text())
    chip = metadata['extra_esptool_args']['chip']
    if chip != 'esp32c6':
        raise ValueError('Distribution is validated only for the C6 profile')
    if metadata.get('flash_settings', {}).get('flash_size') != '4MB':
        raise ValueError('Distribution requires the 4 MB flash profile')
    name = 'espruino-hyperdht-esp32c6-4mb-experimental-' + revision[:12]
    output = exported / 'distribution'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        stage = Path(temp) / name
        stage.mkdir()
        # The exporter's manifest is the allowlist: exclude local flash backups,
        # serial logs and any credentials accidentally placed beside firmware.
        for line in (exported / 'SHA256SUMS').read_text().splitlines():
            digest, filename = line.split('  ', 1)
            if Path(filename).is_absolute() or '..' in Path(filename).parts:
                raise ValueError('Invalid manifest path: ' + filename)
            source = (exported / filename).resolve()
            if not source.is_relative_to(exported) or not source.is_file():
                raise ValueError('Invalid exported artifact: ' + filename)
            if hashlib.sha256(source.read_bytes()).hexdigest() != digest:
                raise ValueError('Exported checksum mismatch: ' + filename)
            target = stage / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        for filename in ['LICENSE', 'THIRD_PARTY.md', 'README.md']:
            shutil.copy2(project / filename, stage / filename)
        shutil.copytree(project / 'docs', stage / 'docs')
        shutil.copytree(project / 'modules', stage / 'modules')
        shutil.copytree(project / 'examples', stage / 'examples')
        shutil.copy2(project / 'docs/RELEASE-BLOCKERS.md', stage / 'RELEASE-BLOCKERS.md')
        notices = stage / 'licenses'
        notices.mkdir()
        for component, source in [
            ('espruino', project / 'deps/espruino/LICENSE'),
            ('hyperdht', project / 'deps/hyperdht/LICENSE'),
            ('libudx', project / 'deps/hyperdht/deps/libudx/LICENSE'),
            ('libudx-NOTICE', project / 'deps/hyperdht/deps/libudx/NOTICE'),
        ]:
            shutil.copy2(source, notices / (component + '.txt'))
        for component in (project / 'deps/espruino/bin/managed_components').iterdir():
            for source in component.rglob('*'):
                if source.is_file() and source.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
                    target = notices / component.name / source.relative_to(component)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        idf = os.environ.get('IDF_PATH')
        if idf:
            shutil.copy2(Path(idf) / 'LICENSE', notices / 'esp-idf.txt')
            for source in (Path(idf) / 'components').rglob('*'):
                if source.is_file() and source.name.upper().startswith(('LICENSE', 'COPYING', 'NOTICE')):
                    target = notices / 'esp-idf-components' / source.relative_to(Path(idf) / 'components')
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        (stage / 'BUILD.json').write_text(json.dumps({
            'project_commit': revision, 'chip': chip, 'flash_size': '4MB',
            'status': 'experimental', 'source_archive': name + '-source.tar.gz',
        }, indent=2) + '\n')
        checksums(stage)
        with tarfile.open(output / (name + '-firmware.tar.gz'), 'w:gz') as archive:
            archive.add(stage, arcname=name)
    with tarfile.open(output / (name + '-source.tar.gz'), 'w:gz') as archive:
        for filename in SOURCE_PATHS:
            archive.add(project / filename, arcname=name + '-source/' + filename,
                        filter=source_filter)
    checksums(output)
    print('Distributable:', output)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: package-distribution.py EXPORTED_FIRMWARE_DIR')
    package(sys.argv[1])
