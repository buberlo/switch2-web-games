#!/usr/bin/env python3
"""Dependency-free local captive portal and single-profile save storage."""

import argparse
import base64
import datetime as dt
import hmac
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import pwd
import re
import secrets
import socket
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
PROJECT = "switch2-web-game"
CAPTIVE_HOSTS = ("ctest.p01.ctest.srv.nintendo.net", "ctest.cdn.nintendo.net", "conntest.nintendowifi.net")
SAVE_NAME = re.compile(r"(?:config\.ini|spawn[0-9]\.sv)\Z")
MAX_SAVE = 8 * 1024 * 1024
MAX_CONFIG = 64 * 1024
MAX_DIAGNOSTICS = 64 * 1024
MIME = {".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm",
        ".mpq": "application/octet-stream", ".svg": "image/svg+xml"}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def safe_path(root, parts):
    """Reject symlinks at every component, not just escapes from the root."""
    root = Path(root)
    if root.is_symlink():
        raise ValueError("symlink root")
    current = root
    for part in parts:
        if part in ("", ".", "..") or "/" in part or "\\" in part or "\x00" in part:
            raise ValueError("invalid path")
        current = current / part
        if current.is_symlink():
            raise ValueError("symlink path")
    if not current.resolve().is_relative_to(root.resolve()):
        raise ValueError("path escape")
    return current


def validate_drop_identity(uid, gid):
    """Resolve an explicit, unprivileged account; never infer identity in HTTP."""
    if uid is None and gid is None:
        if os.geteuid() == 0:
            raise ValueError("root HTTP requires --drop-uid and --drop-gid for an unprivileged account")
        return None
    if os.geteuid() != 0:
        raise ValueError("privilege-drop options require root at startup")
    if any(type(value) is not int or not 0 < value < 2**31 for value in (uid, gid)):
        raise ValueError("drop uid/gid must be positive non-root account identifiers")
    try:
        account = pwd.getpwuid(uid)
    except KeyError as exc:
        raise ValueError("drop uid does not identify an existing account") from exc
    if account.pw_gid != gid:
        raise ValueError("drop gid must match the account's primary group")
    return uid, gid


def prepare_user_storage(server, uid, gid):
    """Repair only this profile's known files, rejecting linked foreign files."""
    def own(path, directory=False, create=False):
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        if directory:
            flags |= getattr(os, "O_DIRECTORY", 0)
        elif create:
            flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if (directory and not stat.S_ISDIR(info.st_mode)) or (not directory and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1)):
                raise ValueError("runtime storage must be ordinary unlinked files/directories")
            if info.st_uid not in (0, uid):
                raise ValueError("runtime storage belongs to another account")
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, 0o700 if directory else 0o600)
        finally:
            os.close(descriptor)

    own(server.data_root, directory=True)
    own(server.save_root, directory=True)
    for name in ("access.jsonl", "diagnostics.jsonl"):
        own(safe_path(server.data_root, [name]), create=True)
    for name in ["config.ini"] + ["spawn%d.sv" % number for number in range(10)]:
        path = safe_path(server.save_root, [name])
        if path.exists():
            own(path)


def create_server(address, root=ROOT, lan_ip=None, drop_uid=None, drop_gid=None):
    identity = validate_drop_identity(drop_uid, drop_gid)
    # HTTPServer binds/listens here, but no request is accepted until the caller
    # enters serve_forever after this function has permanently dropped root.
    server = PortalServer(address, root, lan_ip)
    try:
        if identity:
            uid, gid = identity
            prepare_user_storage(server, uid, gid)
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            if os.getuid() != uid or os.geteuid() != uid or os.getgid() != gid or os.getegid() != gid:
                raise RuntimeError("HTTP privilege drop did not complete")
    except Exception:
        server.server_close()
        raise
    return server


class PortalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, root=ROOT, lan_ip=None, token=None):
        self.root = Path(root).resolve()
        self.web_root = self.root / "web"
        self.data_root = self.root / "data"
        if self.data_root.is_symlink():
            raise ValueError("data directory must not be a symlink")
        self.data_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.save_root = safe_path(self.data_root, ["saves"])
        self.save_root.mkdir(exist_ok=True, mode=0o700)
        self.token = token or secrets.token_urlsafe(32)
        self.instance_id = secrets.token_hex(16)
        self.lock = threading.RLock()
        self.allowed_hosts = {"localhost", "127.0.0.1", "::1", *CAPTIVE_HOSTS}
        bind_host = address[0]
        if bind_host not in ("", "0.0.0.0", "::"):
            self.allowed_hosts.add(bind_host.lower())
        if lan_ip:
            self.allowed_hosts.add(str(ipaddress.ip_address(lan_ip)))
        super().__init__(address, PortalHandler)

    def append_log(self, name, record):
        with self.lock:
            path = safe_path(self.data_root, [name])
            flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags, 0o600)
            with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, separators=(",", ":")) + "\n")

    def status(self):
        try:
            engine = safe_path(self.web_root, ["engine", "DiabloSpawn.js"])
            engine_ready = engine.is_file() and engine.stat().st_size > 0
        except (ValueError, OSError):
            engine_ready = False
        try:
            archive = safe_path(self.data_root, ["assets", "spawn.mpq"])
            with archive.open("rb") as handle:
                data_ready = handle.read(4) == b"MPQ\x1a"
        except (ValueError, OSError):
            data_ready = False
        return {"engineReady": engine_ready, "dataReady": data_ready}


class PortalHandler(BaseHTTPRequestHandler):
    server_version = "SwitchGamePortal/1.0"
    protocol_version = "HTTP/1.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        pass

    def send_response(self, code, message=None):
        self.response_status = code
        super().send_response(code, message)

    def _reply(self, status, body=b"", content_type="application/json", headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _json(self, status, payload):
        self._reply(status, json.dumps(payload, separators=(",", ":")).encode())

    def _error(self, status, message):
        self._json(status, {"error": message})

    def _validated_path(self):
        host_headers = self.headers.get_all("Host", [])
        if len(host_headers) != 1:
            raise ValueError("one Host header required")
        host = host_headers[0]
        if re.search(r"[\s/@\\?#]", host):
            raise ValueError("invalid Host header")
        parsed_host = urlsplit("http://" + host)
        if not parsed_host.hostname or parsed_host.hostname.lower() not in self.server.allowed_hosts:
            raise ValueError("unrecognized Host header")
        port = parsed_host.port  # Also validates malformed ports.
        if port is not None and port != self.server.server_port:
            raise ValueError("unexpected Host port")
        if len(self.path) > 4096:
            raise ValueError("request target too long")
        target = urlsplit(self.path)
        if target.scheme or target.netloc or not self.path.startswith("/"):
            raise ValueError("origin-form target required")
        if re.search(r"%(?![0-9a-fA-F]{2})", target.path):
            raise ValueError("invalid path encoding")
        path = unquote(target.path, errors="strict")
        if "\\" in path or "\x00" in path or any(p in (".", "..") for p in path.split("/")):
            raise ValueError("invalid path")
        return path

    def _same_origin(self):
        if self.headers.get("Sec-Fetch-Site", "").lower() == "cross-site":
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        try:
            parsed = urlsplit(origin)
            host = urlsplit("http://" + self.headers["Host"])
            return (parsed.scheme == "http" and not parsed.username and not parsed.password
                    and not parsed.path and not parsed.query and not parsed.fragment
                    and parsed.hostname == host.hostname and (parsed.port or 80) == (host.port or 80))
        except ValueError:
            return False

    def _authorized(self):
        supplied = self.headers.get("X-Portal-Token", "")
        return self._same_origin() and hmac.compare_digest(supplied.encode(), self.server.token.encode())

    def _read_body(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._error(400, "Transfer-Encoding is unsupported")
            return None
        values = self.headers.get_all("Content-Length", [])
        if len(values) != 1 or not re.fullmatch(r"[0-9]+", values[0]):
            self.close_connection = True
            self._error(411, "valid Content-Length required")
            return None
        length = int(values[0])
        if length > maximum:
            self.close_connection = True
            self._error(413, "request body too large")
            return None
        try:
            body = self.rfile.read(length)
        except (TimeoutError, socket.timeout):
            self.close_connection = True
            self._error(408, "request body timed out")
            return None
        if len(body) != length:
            self.close_connection = True
            self._error(400, "incomplete request body")
            return None
        return body

    def _static_file(self, root, parts, ranges=False):
        try:
            path = safe_path(root, parts)
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        except (ValueError, OSError):
            self._error(404, "file not found")
            return
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                self._error(404, "file not found")
                return
            size = info.st_size
            start, end = 0, size - 1
            status = 200
            range_header = self.headers.get("Range") if ranges else None
            if range_header:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
                if not match or not any(match.groups()) or size == 0:
                    self._reply(416, headers={"Content-Range": "bytes */%d" % size})
                    return
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    suffix = int(right)
                    start = max(0, size - suffix)
                if start > end or start >= size:
                    self._reply(416, headers={"Content-Range": "bytes */%d" % size})
                    return
                status = 206
            length = max(0, end - start + 1)
            self.send_response(status)
            self.send_header("Content-Type", MIME.get(path.suffix.lower(), mimetypes.guess_type(path)[0] or "application/octet-stream"))
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            if ranges:
                self.send_header("Accept-Ranges", "bytes")
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            if self.command == "HEAD":
                return
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _get(self, path):
        if path == "/healthz":
            self._json(200, {"project": PROJECT, "instance": self.server.instance_id, "pid": os.getpid()})
        elif path.startswith("/api/"):
            if not self._same_origin():
                self._error(403, "same-origin request required")
            elif path == "/api/session":
                self._json(200, {"token": self.server.token})
            elif path == "/api/status":
                self._json(200, self.server.status())
            elif path == "/api/saves":
                if not self._authorized():
                    self._error(403, "portal token required")
                    return
                files = []
                with self.server.lock:
                    for name in ["config.ini"] + ["spawn%d.sv" % n for n in range(10)]:
                        file = safe_path(self.server.save_root, [name])
                        limit = MAX_CONFIG if name == "config.ini" else MAX_SAVE
                        if file.is_file() and file.stat().st_size <= limit:
                            files.append({"name": name, "data": base64.b64encode(file.read_bytes()).decode("ascii")})
                self._json(200, {"files": files})
            else:
                self._error(404, "unknown API endpoint")
        elif path in ("/portal", "/portal/"):
            self._static_file(self.server.web_root, ["index.html"])
        elif path in ("/diagnostics", "/diagnostics/"):
            self._static_file(self.server.web_root, ["diagnostics.html"])
        elif path in ("/play/diablo", "/play/diablo/"):
            self._static_file(self.server.web_root, ["diablo.html"])
        elif path == "/game-data/spawn.mpq":
            self._static_file(self.server.data_root, ["assets", "spawn.mpq"], ranges=True)
        elif any(path.startswith(prefix) for prefix in ("/assets/", "/js/", "/engine/")):
            self._static_file(self.server.web_root, path.lstrip("/").split("/"))
        elif path == "/" or self.headers["Host"].split(":")[0].lower() in CAPTIVE_HOSTS:
            self._reply(302, headers={"Location": "/portal"})
        else:
            self._error(404, "page not found")

    def _mutate(self, path):
        if not self._authorized():
            self.close_connection = True
            self._error(403, "same-origin portal token required")
            return
        if path.startswith("/api/saves/") and self.command in ("PUT", "DELETE"):
            name = path[len("/api/saves/"):]
            if not SAVE_NAME.fullmatch(name):
                self.close_connection = True
                self._error(400, "unsupported save filename")
                return
            with self.server.lock:
                file = safe_path(self.server.save_root, [name])
                if self.command == "DELETE":
                    file.unlink(missing_ok=True)
                else:
                    body = self._read_body(MAX_CONFIG if name == "config.ini" else MAX_SAVE)
                    if body is None:
                        return
                    temp = safe_path(self.server.save_root, [".tmp-" + secrets.token_hex(12)])
                    try:
                        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                        with os.fdopen(descriptor, "wb") as handle:
                            handle.write(body)
                            handle.flush()
                            os.fsync(handle.fileno())
                        os.replace(temp, file)
                    finally:
                        temp.unlink(missing_ok=True)
            self._json(200, {"ok": True})
        elif path == "/api/diagnostics" and self.command == "POST":
            body = self._read_body(MAX_DIAGNOSTICS)
            if body is None:
                return
            try:
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise ValueError("object required")
            except (ValueError, UnicodeError):
                self._error(400, "JSON object required")
                return
            self.server.append_log("diagnostics.jsonl", {"receivedAt": utc_now(), "ip": self.client_address[0],
                "userAgent": self.headers.get("User-Agent", "")[:1024], "payload": payload})
            self._json(200, {"ok": True})
        else:
            self.close_connection = True
            self._error(404, "unknown API endpoint")

    def _handle(self):
        self.response_status = 500
        path = ""
        try:
            path = self._validated_path()
            if self.command in ("GET", "HEAD"):
                self._get(path)
            else:
                self._mutate(path)
        except (ValueError, UnicodeError):
            self.close_connection = True
            self._error(400, "invalid request")
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except OSError:
            self.close_connection = True
            self._error(500, "storage error")
        finally:
            try:
                self.server.append_log("access.jsonl", {"at": utc_now(), "ip": self.client_address[0],
                    "method": self.command, "path": path[:2048], "status": self.response_status,
                    "host": self.headers.get("Host", "")[:256], "userAgent": self.headers.get("User-Agent", "")[:1024]})
            except (OSError, ValueError):
                pass

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = _handle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--lan-ip", help="allow this LAN IP in Host headers")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--drop-uid", type=int, help="permanently drop root to this account after binding")
    parser.add_argument("--drop-gid", type=int, help="primary group of --drop-uid")
    args = parser.parse_args()
    try:
        server = create_server((args.host, args.port), args.root, args.lan_ip, args.drop_uid, args.drop_gid)
    except (ValueError, RuntimeError, OSError) as exc:
        parser.error(str(exc))
    print("%s listening at http://%s:%d/portal" % (PROJECT, args.host, server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
