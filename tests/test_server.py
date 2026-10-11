import base64
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from server.portal import CAPTIVE_HOSTS, MAX_DIAGNOSTICS, PortalServer, create_server, prepare_user_storage, validate_drop_identity


class PrivilegeDropTests(unittest.TestCase):
    def test_bind_and_storage_preparation_precede_permanent_privilege_drop(self):
        events = []
        server = mock.Mock()
        account = SimpleNamespace(pw_gid=20)

        def bind(*args):
            events.append("bind")
            return server

        with mock.patch("server.portal.os.geteuid", side_effect=[0, 501]), \
             mock.patch("server.portal.pwd.getpwuid", return_value=account), \
             mock.patch("server.portal.PortalServer", side_effect=bind), \
             mock.patch("server.portal.prepare_user_storage", side_effect=lambda *args: events.append("storage")), \
             mock.patch("server.portal.os.setgroups", side_effect=lambda value: events.append(("groups", value))), \
             mock.patch("server.portal.os.setgid", side_effect=lambda value: events.append(("gid", value))), \
             mock.patch("server.portal.os.setuid", side_effect=lambda value: events.append(("uid", value))), \
             mock.patch("server.portal.os.getuid", return_value=501), \
             mock.patch("server.portal.os.getgid", return_value=20), \
             mock.patch("server.portal.os.getegid", return_value=20):
            self.assertIs(create_server(("192.168.0.104", 80), drop_uid=501, drop_gid=20), server)
        self.assertEqual(events, ["bind", "storage", ("groups", []), ("gid", 20), ("uid", 501)])
        server.serve_forever.assert_not_called()

    def test_failed_drop_closes_bound_server_before_serving(self):
        server = mock.Mock()
        with mock.patch("server.portal.os.geteuid", return_value=0), \
             mock.patch("server.portal.pwd.getpwuid", return_value=SimpleNamespace(pw_gid=20)), \
             mock.patch("server.portal.PortalServer", return_value=server), \
             mock.patch("server.portal.prepare_user_storage"), \
             mock.patch("server.portal.os.setgroups"), mock.patch("server.portal.os.setgid"), \
             mock.patch("server.portal.os.setuid", side_effect=PermissionError("failed")):
            with self.assertRaises(PermissionError):
                create_server(("192.168.0.104", 80), drop_uid=501, drop_gid=20)
        server.server_close.assert_called_once()
        server.serve_forever.assert_not_called()

    def test_root_without_identity_and_invalid_accounts_are_rejected(self):
        with mock.patch("server.portal.os.geteuid", return_value=0), \
             mock.patch("server.portal.pwd.getpwuid", return_value=SimpleNamespace(pw_gid=20)):
            for uid, gid in ((None, None), (0, 20), (501, 0), (501, None), (-1, 20), (501, 80), ("501", 20)):
                with self.assertRaises(ValueError):
                    validate_drop_identity(uid, gid)
        with mock.patch("server.portal.os.geteuid", return_value=501):
            self.assertIsNone(validate_drop_identity(None, None))
            with self.assertRaises(ValueError):
                validate_drop_identity(501, 20)

    def test_storage_ownership_changes_only_known_profile_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            saves = data / "saves"
            saves.mkdir(parents=True)
            (saves / "spawn0.sv").write_bytes(b"save")
            (saves / "unrelated.txt").write_text("leave alone")
            (data / "rig-state.json").write_text("private lifecycle state")
            server = SimpleNamespace(data_root=data, save_root=saves)
            opened = []
            actual_open = os.open

            def observe_open(path, flags, mode=0o777):
                opened.append(Path(path))
                return actual_open(path, flags, mode)

            with mock.patch("server.portal.os.open", side_effect=observe_open), \
                 mock.patch("server.portal.os.fchown") as chown, mock.patch("server.portal.os.fchmod"):
                prepare_user_storage(server, os.getuid(), os.getgid())
            self.assertEqual(set(opened), {data, saves, data / "access.jsonl", data / "diagnostics.jsonl", saves / "spawn0.sv"})
            self.assertEqual(chown.call_count, 5)
            self.assertEqual((saves / "unrelated.txt").read_text(), "leave alone")
            self.assertEqual((data / "rig-state.json").read_text(), "private lifecycle state")


class PortalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        for path, content in {
            "web/index.html": b"portal", "web/diagnostics.html": b"diagnostics",
            "web/diablo.html": b"diablo", "web/assets/icon.svg": b"<svg/>",
            "web/js/app.js": b"var ok = true;", "web/engine/DiabloSpawn.js": b"var Module;",
            "data/assets/spawn.mpq": b"MPQ\x1a0123456789",
        }.items():
            file = self.root / path
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        self.server = PortalServer(("127.0.0.1", 0), root=self.root)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.token = self.server.token

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None, token=False):
        headers = dict(headers or {})
        if token:
            headers["X-Portal-Token"] = self.token
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def test_captive_get_and_head_are_redirects(self):
        for host in CAPTIVE_HOSTS:
            for method in ("GET", "HEAD"):
                for path in ("/", "/connectivity-check"):
                    code, headers, body = self.request(method, path, headers={"Host": host})
                    self.assertEqual((code, headers["Location"], body), (302, "/portal", b""))

    def test_routes_and_head_preserve_lengths(self):
        for path, expected in (("/portal", b"portal"), ("/diagnostics", b"diagnostics"),
                               ("/play/diablo", b"diablo"), ("/js/app.js", b"var ok = true;")):
            code, headers, body = self.request("GET", path)
            self.assertEqual((code, body), (200, expected))
            code, head_headers, body = self.request("HEAD", path)
            self.assertEqual((code, body, head_headers["Content-Length"]), (200, b"", str(len(expected))))
        self.assertEqual(self.request("GET", "/js/missing.js")[0], 404)
        self.assertEqual(self.request("GET", "/unknown")[0], 404)

    def test_archive_range_and_suffix(self):
        for value, wanted, expected in (("bytes=4-7", b"0123", "bytes 4-7/14"),
                                         ("bytes=-3", b"789", "bytes 11-13/14"),
                                         ("bytes=11-99", b"789", "bytes 11-13/14")):
            code, headers, body = self.request("GET", "/game-data/spawn.mpq", headers={"Range": value})
            self.assertEqual((code, body, headers["Content-Range"]), (206, wanted, expected))
            code, headers, body = self.request("HEAD", "/game-data/spawn.mpq", headers={"Range": value})
            self.assertEqual((code, body, headers["Content-Length"]), (206, b"", str(len(wanted))))
        for invalid in ("bytes=100-", "bytes=-0", "bytes=3-1", "bytes=0-1,4-5", "abc"):
            self.assertEqual(self.request("GET", "/game-data/spawn.mpq", headers={"Range": invalid})[0], 416)

    def test_session_and_readiness(self):
        code, headers, body = self.request("GET", "/api/session")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(body), {"token": self.token})
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(json.loads(self.request("GET", "/api/status")[2]), {"engineReady": True, "dataReady": True})
        (self.root / "data/assets/spawn.mpq").write_bytes(b"HTML")
        self.assertFalse(json.loads(self.request("GET", "/api/status")[2])["dataReady"])
        self.assertEqual(json.loads(self.request("GET", "/healthz")[2])["project"], "switch2-web-game")

    def test_save_roundtrip_and_delete(self):
        data = b"\x00\x01game-save\xff"
        self.assertEqual(self.request("PUT", "/api/saves/spawn0.sv", data, token=True)[0], 200)
        self.assertEqual(self.request("PUT", "/api/saves/config.ini", b"[game]\n", token=True)[0], 200)
        files = json.loads(self.request("GET", "/api/saves", token=True)[2])["files"]
        saved = {item["name"]: base64.b64decode(item["data"]) for item in files}
        self.assertEqual(saved["spawn0.sv"], data)
        self.assertEqual(self.request("DELETE", "/api/saves/spawn0.sv", token=True)[0], 200)
        self.assertEqual(self.request("DELETE", "/api/saves/spawn0.sv", token=True)[0], 200)
        self.assertFalse((self.root / "data/saves/spawn0.sv").exists())
        self.assertEqual(list((self.root / "data/saves").glob(".tmp-*")), [])

    def test_token_is_required_for_private_reads_and_writes(self):
        for method, path, body in (("GET", "/api/saves", None), ("PUT", "/api/saves/spawn1.sv", b"save"),
                                  ("DELETE", "/api/saves/spawn1.sv", None), ("POST", "/api/diagnostics", b"{}")):
            self.assertEqual(self.request(method, path, body)[0], 403)
            self.assertEqual(self.request(method, path, body, headers={"X-Portal-Token": "wrong"})[0], 403)

    def test_origin_and_host_injection_rejected(self):
        self.assertEqual(self.request("GET", "/api/session", headers={"Host": "evil.test"})[0], 400)
        for headers in ({"Origin": "https://evil.test"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("GET", "/api/session", headers=headers)[0], 403)
            self.assertEqual(self.request("PUT", "/api/saves/spawn0.sv", b"save", headers=headers, token=True)[0], 403)
        origin = "http://127.0.0.1:%d" % self.server.server_port
        self.assertEqual(self.request("PUT", "/api/saves/spawn0.sv", b"save", headers={"Origin": origin}, token=True)[0], 200)

    def test_traversal_and_symlinks_rejected(self):
        for path in ("/assets/../index.html", "/assets/%2e%2e/index.html", "/assets/%5csecret", "/assets/%00"):
            self.assertEqual(self.request("GET", path)[0], 400)
        outside = self.root / "secret.txt"
        outside.write_text("secret")
        (self.root / "web/assets/leak.txt").symlink_to(outside)
        self.assertEqual(self.request("GET", "/assets/leak.txt")[0], 404)
        (self.root / "data/saves/spawn0.sv").symlink_to(outside)
        self.assertEqual(self.request("PUT", "/api/saves/spawn0.sv", b"changed", token=True)[0], 400)
        self.assertEqual(outside.read_text(), "secret")
        for filename in ("diablo.ini", "spawn10.sv", "single_0.sv", "../secret.txt"):
            self.assertEqual(self.request("PUT", "/api/saves/" + filename, b"save", token=True)[0], 400)

    def test_bounded_diagnostics_and_logs(self):
        payload = {"canvas2d": "passed", "wasm": "unavailable"}
        self.assertEqual(self.request("POST", "/api/diagnostics", json.dumps(payload).encode(), token=True)[0], 200)
        record = json.loads((self.root / "data/diagnostics.jsonl").read_text())
        self.assertEqual(record["payload"], payload)
        self.assertEqual(self.request("POST", "/api/diagnostics", b"[]", token=True)[0], 400)
        self.assertEqual(self.request("POST", "/api/diagnostics", b"x" * (MAX_DIAGNOSTICS + 1), token=True)[0], 413)
        self.request("GET", "/healthz")
        records = [json.loads(line) for line in (self.root / "data/access.jsonl").read_text().splitlines()]
        self.assertTrue(any(record["path"] == "/api/diagnostics" and record["status"] == 200 for record in records))
        self.assertNotIn(self.token, (self.root / "data/access.jsonl").read_text())

    def test_config_limit_and_save_survives_rejected_write(self):
        self.request("PUT", "/api/saves/config.ini", b"good", token=True)
        self.assertEqual(self.request("PUT", "/api/saves/config.ini", b"x" * (65536 + 1), token=True)[0], 413)
        self.assertEqual((self.root / "data/saves/config.ini").read_bytes(), b"good")


if __name__ == "__main__":
    unittest.main()
