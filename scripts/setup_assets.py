#!/usr/bin/env python3
"""Fetch the pinned Diablo shareware archive; never fetch retail game data."""
import hashlib
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = "https://raw.githubusercontent.com/d07RiV/diabloweb/6e187315aec6bd7c0b53275ef0228718a789ecff/spawn.mpq"
SIZE = 25_830_791
SHA256 = "21d125650291d6099a4a49e325374add8fbc3ac17f97d64fac83bbdd3364f28f"
DEST = ROOT / "data/assets/spawn.mpq"


def verify(path):
    if not path.is_file() or path.stat().st_size != SIZE:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        if handle.read(4) != b"MPQ\x1a":
            return False
        handle.seek(0)
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == SHA256


def main():
    DEST.parent.mkdir(parents=True, exist_ok=True)
    if verify(DEST):
        print("Shareware archive verified:", DEST)
        return
    temporary = DEST.with_suffix(".mpq.download")
    try:
        with urllib.request.urlopen(URL, timeout=60) as response, temporary.open("wb") as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if not verify(temporary):
            raise RuntimeError("Shareware archive size, MPQ magic, or SHA-256 did not match the pinned source")
        temporary.replace(DEST)
    finally:
        temporary.unlink(missing_ok=True)
    print("Shareware archive downloaded and verified:", DEST)


if __name__ == "__main__":
    main()
