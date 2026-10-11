#!/usr/bin/env python3
"""Generate the local engine/frontend identity used by device diagnostics.

Run after editing game frontend files, or after a default engine build. This
manifest is a generated local asset; it contains relative paths and no secrets.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_PATHS = (
    "web/diablo.html",
    "web/js/common.js",
    "web/js/diablo.js",
    "web/js/diablo-host.js",
    "web/js/diablo-worker.js",
    "web/js/diablo-audio.js",
    "web/js/diablo-renderer.js",
    "web/js/diablo-benchmark.js",
    "web/assets/diablo.css",
    "web/assets/diablo-loading.css",
)
MANIFEST_PATH = "web/assets/runtime.json"


def digest(body):
    return hashlib.sha256(body).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def file_record(root, relative):
    body = (root / relative).read_bytes()
    return {"path": relative, "sha256": digest(body), "bytes": len(body)}


def build_manifest(root):
    root = Path(root)
    engine = file_record(root, "web/engine/DiabloSpawn.js")
    metadata = json.loads((root / "web/engine/build.json").read_text())
    if metadata.get("sha256") != engine["sha256"]:
        raise RuntimeError("Engine bytes do not match web/engine/build.json; finish the engine build before publishing runtime identity")
    if metadata.get("bytes") != engine["bytes"]:
        raise RuntimeError("Engine size does not match web/engine/build.json")
    sources = [file_record(root, relative) for relative in FRONTEND_PATHS]
    frontend_hash = digest(canonical(sources))
    identity = {"engineSha256": engine["sha256"], "frontendSha256": frontend_hash}
    return {"schemaVersion": 1, **identity, "revisionSha256": digest(canonical(identity)),
            "engine": engine, "sources": sources}


def write_manifest(root, manifest):
    destination = Path(root) / MANIFEST_PATH
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="runtime-",
                                         suffix=".tmp", dir=str(destination.parent), delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(manifest, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="Project root (default: this checkout)")
    parser.add_argument("--check", action="store_true", help="Check the saved manifest without writing it")
    args = parser.parse_args(argv)
    try:
        manifest = build_manifest(args.root)
        if args.check:
            saved = json.loads((args.root / MANIFEST_PATH).read_text())
            if saved != manifest:
                raise RuntimeError("Runtime identity is stale; run python3 scripts/build_runtime.py")
        else:
            write_manifest(args.root, manifest)
        print("Runtime identity " + manifest["revisionSha256"] + (" (verified)" if args.check else " (generated)"))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print("runtime: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
