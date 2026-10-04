#!/usr/bin/env python3
"""Fetch exact upstream revisions. Requires Python 3.12+, curl and tar."""
import json, pathlib, subprocess, tarfile
root = pathlib.Path(__file__).resolve().parents[1]
lock = json.loads((root / 'dependencies.json').read_text())
deps = root / 'deps'
deps.mkdir(exist_ok=True)
for name in ('espruino', 'hyperdht', 'libudx'):
    entry = lock[name]
    destination = deps / name if name != 'libudx' else deps / 'hyperdht/deps/libudx'
    marker = destination / '.source-revision'
    if marker.exists() and marker.read_text().strip() == entry['commit']:
        print(name + ': already fetched', flush=True)
        continue
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit('Refusing to overwrite nonempty ' + str(destination))
    archive = deps / (name + '.tar.gz')
    subprocess.run(['curl', '--fail', '--location', '--retry', '3',
                    'https://codeload.github.com/' + entry['repo'] + '/tar.gz/' + entry['commit'],
                    '-o', str(archive)], check=True)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        prefix = members[0].name.split('/')[0] + '/'
        for member in members:
            if not member.name.startswith(prefix): continue
            member.name = member.name[len(prefix):]
            if member.name: tar.extract(member, destination, filter='data')
    if name == 'espruino':
        subprocess.run(['git', 'init', '-q', str(destination)], check=True)
        subprocess.run(['git', '-C', str(destination), '-c', 'user.name=Source archive', '-c', 'user.email=build@localhost', 'commit', '-q', '--allow-empty', '-m', 'Upstream archive ' + entry['commit']], check=True)
    marker.write_text(entry['commit'] + '\n')
    archive.unlink()
    print(name + ': ' + entry['commit'], flush=True)
