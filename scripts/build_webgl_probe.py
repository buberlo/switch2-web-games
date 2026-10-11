#!/usr/bin/env python3
"""Build the allowlisted static WebGL control and matching local probe identity."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.parse import urlsplit
import ipaddress

ROOT = Path(__file__).resolve().parents[1]
SOURCES = (
    "assets/webgl-research.html", "assets/webgl-research.css",
    "js/common.js", "js/webgl-probe.js", "js/webgl-research.js",
)
CONFIG = "assets/webgl-research-config.js"
OUTPUT = "data/webgl-public"


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def validate_origin(value, public=True):
    if not value:
        return ""
    parsed = urlsplit(value)
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError("Use a bare origin without credentials, path, query or fragment")
    if not parsed.hostname or not re.fullmatch(r"[a-zA-Z0-9.-]+", parsed.hostname):
        raise ValueError("Invalid origin hostname")
    if parsed.port is not None and not 1 <= parsed.port <= 65535:
        raise ValueError("Invalid origin port")
    if public:
        if parsed.scheme != "https" or "." not in parsed.hostname:
            raise ValueError("Public origin must use HTTPS and a hostname")
        try:
            ipaddress.ip_address(parsed.hostname)
        except ValueError:
            pass
        else:
            raise ValueError("Public origin must use a hostname with a valid certificate")
    else:
        if parsed.scheme != "http":
            raise ValueError("LAN origin must use HTTP")
        if parsed.hostname != "localhost":
            address = ipaddress.IPv4Address(parsed.hostname)
            if not any(address in ipaddress.ip_network(network) for network in
                       ("10.0.0.0/8", "127.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
                raise ValueError("LAN origin must be a private IPv4 address or localhost")
    return value


def config_bytes(value):
    return b"window.SwitchWebGLResearchConfig=" + encoded(value) + b";\n"


def ordinary_path(root, path):
    """Reject symlinks in the allowlisted file and every project-relative parent."""
    current = Path(root)
    for part in Path(path).relative_to(root).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Probe paths must be ordinary local files and directories")


def build(root, public_origin="", lan_origin=""):
    public_origin = validate_origin(public_origin)
    lan_origin = validate_origin(lan_origin, public=False)
    root = Path(root)
    files = {}
    for relative in SOURCES:
        source = root / "web" / relative
        ordinary_path(root, source)
        files[relative] = source.read_bytes()
    records = [{"path": relative, "sha256": hashlib.sha256(files[relative]).hexdigest(),
                "bytes": len(files[relative])} for relative in SOURCES]
    revision = hashlib.sha256(encoded(records)).hexdigest()
    config = {"revision": revision, "publicOrigin": public_origin}
    files[CONFIG] = config_bytes(config)
    local_config = config_bytes(dict(config, lanOrigin=lan_origin))
    files["manifest.json"] = encoded({"schemaVersion": 1, "revision": revision, "sources": records}) + b"\n"
    files["index.html"] = (b'<!doctype html><html lang="en"><meta charset="utf-8">'
        b'<meta name="referrer" content="no-referrer"><title>Switch 2 WebGL research</title>'
        b'<a href="/assets/webgl-research.html">Open Switch 2 WebGL research</a></html>\n')
    # An explicit 404 prevents Pages' single-page-app fallback exposing a false success.
    files["404.html"] = b'<!doctype html><title>Not found</title><h1>Probe asset not found</h1>\n'
    files["_headers"] = (b"/*\n  Cache-Control: no-store\n  X-Content-Type-Options: nosniff\n"
                         b"  Referrer-Policy: no-referrer\n")
    return revision, files, local_config


def atomic_file(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        temporary.chmod(0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def publish(root, files, local_config):
    root = Path(root)
    parent = root / "data"
    ordinary_path(root, parent)
    local_path = root / "web" / CONFIG
    ordinary_path(root, local_path)
    parent.mkdir(exist_ok=True)
    output, backup = root / OUTPUT, parent / "webgl-public.previous"
    if output.is_symlink() or backup.is_symlink():
        raise ValueError("Public bundle paths must not be symlinks")
    staged = Path(tempfile.mkdtemp(prefix="webgl-public-", dir=parent))
    old_config = local_path.read_bytes() if local_path.exists() else None
    installed = False
    moved_previous = False
    try:
        for relative, body in files.items():
            path = staged / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        if backup.exists():
            shutil.rmtree(backup)
        if output.exists():
            output.rename(backup)
            moved_previous = True
        if old_config is not None:
            atomic_file(parent / "webgl-local-config.previous.js", old_config)
        staged.rename(output)
        installed = True
        atomic_file(local_path, local_config)
    except OSError:
        if installed:
            shutil.rmtree(output)
        if moved_previous:
            backup.rename(output)
        raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)


def check(root, files, local_config):
    output = Path(root) / OUTPUT
    ordinary_path(Path(root), output)
    for path in output.rglob("*"):
        ordinary_path(Path(root), path)
        if not path.is_file() and not path.is_dir():
            raise ValueError("Public bundle contains a nonregular entry")
    actual = {str(path.relative_to(output)) for path in output.rglob("*") if path.is_file()}
    if actual != set(files):
        raise ValueError("Public bundle has missing or unexpected files; rebuild before upload")
    for relative, body in files.items():
        if (output / relative).is_symlink() or (output / relative).read_bytes() != body:
            raise ValueError("Stale public probe asset: " + relative)
    ordinary_path(Path(root), Path(root) / "web" / CONFIG)
    if (Path(root) / "web" / CONFIG).read_bytes() != local_config:
        raise ValueError("Local probe identity is stale; rebuild before measuring")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--public-origin", default="", help="Verified HTTPS deployment origin")
    parser.add_argument("--lan-origin", default="", help="Private HTTP origin, written ONLY to the LAN config")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        revision, files, local_config = build(args.root, args.public_origin, args.lan_origin)
        if args.check:
            check(args.root, files, local_config)
        else:
            publish(args.root, files, local_config)
        print("WebGL probe " + revision + (" (verified)" if args.check else " (built)"))
        print("Static upload folder: " + str(args.root / OUTPUT))
        return 0
    except (OSError, ValueError) as error:
        print("webgl-probe: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
