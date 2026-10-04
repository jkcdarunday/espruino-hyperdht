#!/usr/bin/env python3
"""Reject machine-specific paths, private network addresses and device IDs."""
from pathlib import Path
import re
import subprocess

patterns = {
    'personal home path': re.compile(r'/(?:home|Users)/[^/\s]+/'),
    'temporary machine workspace': re.compile(r'/workspace/(?:scratch)/[a-zA-Z0-9_-]+/'),
    'private network address': re.compile(r'(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?![\d.])'),
    'device-specific backup name': re.compile(r'board-backup-[0-9a-fA-F]{12}-'),
}
failed = False
files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
for filename in filter(None, files):
    try:
        text = Path(filename).read_text()
    except UnicodeDecodeError:
        continue
    for kind, pattern in patterns.items():
        if pattern.search(text):
            print(f'{filename}: {kind}; replace with a portable placeholder')
            failed = True
if failed:
    raise SystemExit(1)
print('Repository privacy check: PASS')
