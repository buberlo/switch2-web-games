import json
import os
from pathlib import Path
import random
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts.rig import CAPTIVE_HOSTS, Rig, RigError, assert_port_available, dns_config, dnsmasq_binary, owns_process, parse_listeners, preflight_replacement, stop_owned, sudo_http_identity, verify_owned_listeners


class CliSetupTests(unittest.TestCase):
    def test_cutover_requires_explicit_research_path_before_mutating_services(self):
        from scripts.rig import main
        for apply in (False, True):
            args = ["rig.py", "cutover", "--lan-ip", "192.168.0.104"] + (["--apply"] if apply else [])
            with mock.patch.object(sys, "argv", args), mock.patch("scripts.rig.Rig") as rig, \
                 mock.patch("scripts.rig.sys.stderr") as error:
                with self.assertRaises(SystemExit) as exited:
                    main()
                self.assertEqual(exited.exception.code, 1)
                self.assertIn("--research-root is required", "".join(str(call) for call in error.write.call_args_list))
                rig.return_value.cutover.assert_not_called()
                rig.return_value.start.assert_not_called()
                rig.return_value.locked.assert_not_called()


class SudoIdentityTests(unittest.TestCase):
    def test_valid_sudo_identity_resolves_normal_account(self):
        with mock.patch("scripts.rig.os.geteuid", return_value=0), \
             mock.patch.dict(os.environ, {"SUDO_UID": "501", "SUDO_GID": "20", "SUDO_USER": "portaluser"}, clear=True), \
             mock.patch("scripts.rig.pwd.getpwuid", return_value=SimpleNamespace(pw_gid=20, pw_name="portaluser")):
            self.assertEqual(sudo_http_identity(), (501, 20))

    def test_bad_sudo_environment_is_rejected_before_services_change(self):
        for env in ({}, {"SUDO_UID": "0", "SUDO_GID": "20"}, {"SUDO_UID": "501\n", "SUDO_GID": "20"},
                    {"SUDO_UID": "501", "SUDO_GID": "0"}, {"SUDO_UID": "501", "SUDO_GID": "80"},
                    {"SUDO_UID": "501", "SUDO_GID": "20", "SUDO_USER": "different"}):
            with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch.dict(os.environ, env, clear=True), \
                 mock.patch("scripts.rig.pwd.getpwuid", return_value=SimpleNamespace(pw_gid=20, pw_name="portaluser")):
                with self.assertRaises(RigError):
                    sudo_http_identity()

    def test_unprivileged_development_does_not_use_sudo_environment(self):
        with mock.patch("scripts.rig.os.geteuid", return_value=501), mock.patch.dict(os.environ, {"SUDO_UID": "0"}, clear=True):
            self.assertIsNone(sudo_http_identity())


class DnsConfigTests(unittest.TestCase):
    def test_only_captive_names_are_overridden_and_upstream_is_preserved(self):
        config = dns_config("192.168.0.104", "192.168.0.1")
        self.assertIn("server=192.168.0.1\n", config)
        self.assertIn("listen-address=192.168.0.104\n", config)
        for host in CAPTIVE_HOSTS:
            self.assertIn("host-record=%s,192.168.0.104,15\n" % host, config)
            self.assertIn("local=/%s/\n" % host, config)
        self.assertNotIn("/#/", config)
        self.assertNotIn("\naddress=", config)
        self.assertNotIn("\nlocal=/nintendo.net/", config)
        self.assertIn("port=5354\n", dns_config("192.168.0.104", "1.1.1.1", 5354))

    def test_rejects_resolver_loops_and_config_injection(self):
        for lan, upstream in (("192.168.0.104", "192.168.0.104"), ("0.0.0.0", "1.1.1.1"),
                              ("192.168.0.104", "127.0.0.1"), ("192.168.0.104\naddress=/#/1.2.3.4", "1.1.1.1")):
            with self.assertRaises((RigError, ValueError)):
                dns_config(lan, upstream)


class DnsForwardingTests(unittest.TestCase):
    def test_real_dnsmasq_forwards_external_names_to_mock_upstream(self):
        self.run_dns_scenario()

    @unittest.skipUnless(sys.platform == "darwin", "BSD wildcard binding regression")
    def test_dnsmasq_coexists_with_compatible_ipv6_wildcard_on_macos(self):
        self.run_dns_scenario(with_wildcard=True)

    def run_dns_scenario(self, with_wildcard=False):
        try:
            binary = dnsmasq_binary()
        except RigError:
            self.skipTest("dnsmasq is not installed")
        upstream = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        upstream.bind(("127.0.0.1", 0))
        upstream.settimeout(0.1)
        wildcard = None
        if with_wildcard:
            wildcard = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            wildcard.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            wildcard.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            wildcard.bind(("::", 0))
            wildcard.listen(1)
            port = wildcard.getsockname()[1]
            with socket.socket() as no_reuse:
                with self.assertRaises(OSError):
                    no_reuse.bind(("127.0.0.1", port))
            assert_port_available("127.0.0.1", port)
        else:
            with socket.socket() as port_socket:
                port_socket.bind(("127.0.0.1", 0))
                port = port_socket.getsockname()[1]
        queries, finished = [], threading.Event()

        def resolver():
            while not finished.is_set():
                try:
                    data, sender = upstream.recvfrom(4096)
                except socket.timeout:
                    continue
                labels, cursor = [], 12
                while data[cursor]:
                    length = data[cursor]
                    cursor += 1
                    labels.append(data[cursor:cursor + length].decode())
                    cursor += length
                question_end = cursor + 5
                queries.append(".".join(labels))
                header = data[:2] + struct.pack("!HHHHH", 0x8180, 1, 1, 0, 0)
                answer = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 15, 4) + bytes((203, 0, 113, 7))
                upstream.sendto(header + data[12:question_end] + answer, sender)

        worker = threading.Thread(target=resolver)
        worker.start()

        def query(name, kind=1, tcp=False):
            packet = struct.pack("!HHHHHH", random.randrange(65536), 0x100, 1, 0, 0, 0)
            packet += b"".join(bytes([len(label)]) + label.encode() for label in name.split("."))
            packet += b"\0" + struct.pack("!HH", kind, 1)
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as client:
                client.settimeout(0.3)
                if tcp:
                    client.connect(("127.0.0.1", port))
                    client.sendall(struct.pack("!H", len(packet)) + packet)
                    size = struct.unpack("!H", client.recv(2))[0]
                    response = b""
                    while len(response) < size:
                        response += client.recv(size - len(response))
                    return response
                client.sendto(packet, ("127.0.0.1", port))
                return client.recv(4096)

        try:
            with tempfile.TemporaryDirectory() as directory:
                config = dns_config("192.168.0.104", "1.1.1.1", port)
                config = config.replace("listen-address=192.168.0.104", "listen-address=127.0.0.1")
                config = config.replace("server=1.1.1.1", "server=127.0.0.1#%d" % upstream.getsockname()[1])
                path = Path(directory) / "dnsmasq.conf"
                path.write_text(config)
                process = subprocess.Popen([binary, "--keep-in-foreground", "--conf-file=" + str(path),
                                            "--pid-file=" + str(Path(directory) / "dnsmasq.pid")],
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                try:
                    response = None
                    for _ in range(30):
                        try:
                            response = query(CAPTIVE_HOSTS[0])
                            break
                        except (TimeoutError, OSError):
                            if process.poll() is not None:
                                self.fail("isolated test dnsmasq exited")
                            time.sleep(0.05)
                    self.assertIsNotNone(response)
                    self.assertEqual(response[-4:], bytes((192, 168, 0, 104)))
                    self.assertEqual(query(CAPTIVE_HOSTS[1], tcp=True)[-4:], bytes((192, 168, 0, 104)))
                    self.assertEqual(query(CAPTIVE_HOSTS[2])[-4:], bytes((192, 168, 0, 104)))
                    aaaa = query(CAPTIVE_HOSTS[0], kind=28)
                    self.assertEqual(struct.unpack("!H", aaaa[6:8])[0], 0)
                    self.assertEqual(aaaa[3] & 0x0F, 0)  # NOERROR/NODATA, not REFUSED.
                    external = query("game-assets.example.com")
                    self.assertEqual(external[-4:], bytes((203, 0, 113, 7)))
                    self.assertEqual(queries, ["game-assets.example.com"])
                finally:
                    process.terminate()
                    process.wait(timeout=3)
        finally:
            finished.set()
            worker.join(timeout=1)
            upstream.close()
            if wildcard:
                wildcard.close()


class ListenerPreflightTests(unittest.TestCase):
    def test_reuse_probe_refuses_exact_udp_listener_before_binding(self):
        with mock.patch("scripts.rig.inspect_listeners", return_value=[{"pid": 30, "address": "192.168.0.104"}]), \
             mock.patch("scripts.rig.socket.socket") as socket_factory:
            with self.assertRaisesRegex(RigError, "existing exact-address UDP"):
                assert_port_available("192.168.0.104", 53, udp=True)
        socket_factory.assert_not_called()

    def test_lsof_parses_actual_macos_tcp_queue_fields(self):
        output = "p75704\nclimactl\nf12\ntIPv6\nPTCP\nn*:53\nTST=LISTEN\nTQR=0\nTQS=0\n"
        record = parse_listeners(output, "TCP", 53)[0]
        self.assertEqual((record["pid"], record["address"], record["state"]), (75704, "*", "LISTEN"))
        with self.assertRaises(RigError):
            parse_listeners("p1\ncunknown\nf4\ntIPv4\nPTCP\nnbad-name\n", "TCP", 53)

    def test_udp_remote_dns_connection_is_not_a_bound_port53_listener(self):
        output = "p1\ncclient\nf4\ntIPv4\nPUDP\nn192.168.0.104:60000->1.1.1.1:53\n"
        self.assertEqual(parse_listeners(output, "UDP", 53), [])

    def test_same_snapshot_proves_owned_exact_and_foreign_wildcard_coexistence(self):
        http = {"pid": 10, "address": "*"}
        dns = {"pid": 20, "address": "192.168.0.104"}
        wildcard = {"pid": 30, "address": "::"}
        with mock.patch("scripts.rig.owns_process", return_value=True), \
             mock.patch("scripts.rig.inspect_listeners", side_effect=[[http], [dns, wildcard], [dns]]), \
             mock.patch("scripts.rig.assert_port_available") as probe:
            audit = preflight_replacement("192.168.0.104", 80, 53, [http, dns])
        self.assertIn("already coexists", audit[1]["evidence"])
        probe.assert_not_called()

    def test_foreign_exact_listener_is_never_shared(self):
        with mock.patch("scripts.rig.inspect_listeners", return_value=[{"pid": 30, "address": "192.168.0.104"}]):
            with self.assertRaisesRegex(RigError, "foreign TCP listener"):
                preflight_replacement("192.168.0.104", 80, 53, [])

    def test_unoccupied_exact_endpoint_probes_beside_wildcard(self):
        with mock.patch("scripts.rig.inspect_listeners", side_effect=[[], [{"pid": 30, "address": "*"}], []]), \
             mock.patch("scripts.rig.assert_port_available") as probe:
            preflight_replacement("192.168.0.104", 80, 53, [])
        self.assertEqual(probe.call_args_list, [mock.call("192.168.0.104", 80, udp=False),
            mock.call("192.168.0.104", 53, udp=False), mock.call("192.168.0.104", 53, udp=True)])

    def test_alive_process_without_required_dns_sockets_is_not_ready(self):
        with mock.patch("scripts.rig.owns_process", return_value=True), mock.patch("scripts.rig.inspect_listeners", return_value=[]), \
             mock.patch("scripts.rig.time.sleep"):
            with self.assertRaisesRegex(RigError, "does not own all expected listeners"):
                verify_owned_listeners({"pid": 20}, "192.168.0.104", [("TCP", 53), ("UDP", 53)])

    def test_process_exit_before_listener_check_is_not_ready(self):
        with mock.patch("scripts.rig.owns_process", return_value=False):
            with self.assertRaisesRegex(RigError, "service exited"):
                verify_owned_listeners({"pid": 20}, "192.168.0.104", [("UDP", 53)])


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rig = Rig(self.root)
        self.rig.ensure_data()
        self.record = {"pid": 2345, "command": "python /project/server/portal.py", "started": "Sun Oct 11 12:00:00 2026"}

    def tearDown(self):
        self.temp.cleanup()

    def test_process_ownership_requires_creation_stamp_and_command(self):
        with mock.patch("scripts.rig.process_identity", return_value=dict(self.record)):
            self.assertTrue(owns_process(self.record))
        for change in ({"started": "different"}, {"command": "unrelated service"}):
            with mock.patch("scripts.rig.process_identity", return_value={**self.record, **change}):
                self.assertFalse(owns_process(self.record))

    def test_refuses_to_kill_a_reused_pid(self):
        with mock.patch("scripts.rig.process_identity", return_value={**self.record, "command": "another app"}), \
             mock.patch("scripts.rig.process_exists", return_value=True), mock.patch("scripts.rig.os.kill") as kill:
            with self.assertRaises(RigError):
                stop_owned(self.record)
            kill.assert_not_called()

    def test_stop_only_signals_owned_services(self):
        self.rig.state_file.write_text(json.dumps({"services": {"http": self.record}}))
        with mock.patch("scripts.rig.owns_process", return_value=True), mock.patch("scripts.rig.stop_owned") as stop:
            self.assertEqual(self.rig.stop()["state"], "stopped")
            stop.assert_called_once_with(self.record)
        self.assertFalse(self.rig.state_file.exists())

    def test_changed_identity_keeps_state_for_review(self):
        self.rig.state_file.write_text(json.dumps({"services": {"http": self.record}}))
        with mock.patch("scripts.rig.owns_process", return_value=False), mock.patch("scripts.rig.process_exists", return_value=True), \
             mock.patch("scripts.rig.stop_owned") as stop:
            self.assertEqual(self.rig.status()["state"], "needs-review")
            with self.assertRaises(RigError):
                self.rig.stop()
            stop.assert_not_called()
        self.assertTrue(self.rig.state_file.exists())

    def test_start_refuses_existing_state_without_touching_services(self):
        self.rig.state_file.write_text(json.dumps({"services": {"http": self.record}}))
        with mock.patch.object(self.rig, "launch") as launch:
            with self.assertRaises(RigError):
                self.rig.start("192.168.0.104", "1.1.1.1")
            launch.assert_not_called()

    def test_start_refuses_port_conflict_before_spawning(self):
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.sudo_http_identity", return_value=(501, 20)), \
             mock.patch("scripts.rig.pf_check"), \
             mock.patch("scripts.rig.assert_port_available", side_effect=RigError("in use")), mock.patch.object(self.rig, "launch") as launch:
            with self.assertRaisesRegex(RigError, "in use"):
                self.rig.start("192.168.0.104", "1.1.1.1")
            launch.assert_not_called()

    def test_dry_cutover_does_not_write_or_stop_any_service(self):
        plan = {"services": [{"name": "http", **self.record}], "researchRoot": "/research"}
        with mock.patch.object(self.rig, "research_plan", return_value=plan), mock.patch("scripts.rig.stop_owned") as stop:
            result = self.rig.cutover("/research", "192.168.0.104", "1.1.1.1")
            self.assertFalse(result["apply"])
            stop.assert_not_called()
        self.assertFalse(self.rig.handoff_file.exists())

    def test_failed_cutover_calls_rollback_and_preserves_error(self):
        plan = {"services": [{"name": "http", **self.record}], "researchRoot": "/research"}
        with mock.patch.object(self.rig, "research_plan", return_value=plan), mock.patch("scripts.rig.os.geteuid", return_value=0), \
             mock.patch("scripts.rig.sudo_http_identity", return_value=(501, 20)), \
             mock.patch("scripts.rig.pf_check"), mock.patch("scripts.rig.dnsmasq_binary", return_value="/bin/dnsmasq"), \
             mock.patch("scripts.rig.preflight_replacement", return_value=[]), \
             mock.patch.object(self.rig, "validate_dns"), mock.patch("scripts.rig.stop_owned"), \
             mock.patch.object(self.rig, "start", side_effect=RigError("port occupied")), mock.patch.object(self.rig, "rollback") as rollback:
            with self.assertRaisesRegex(RigError, "previous direct services restored"):
                self.rig.cutover("/research", "192.168.0.104", "1.1.1.1", apply=True)
            rollback.assert_called_once_with(apply=True)
        self.assertEqual(json.loads(self.rig.handoff_file.read_text())["stopped"], ["http"])

    def test_cutover_foreign_listener_failure_precedes_stopping_or_handoff(self):
        plan = {"services": [{"name": "http", **self.record}], "researchRoot": "/research"}
        with mock.patch.object(self.rig, "research_plan", return_value=plan), mock.patch("scripts.rig.os.geteuid", return_value=0), \
             mock.patch("scripts.rig.sudo_http_identity", return_value=(501, 20)), mock.patch("scripts.rig.pf_check"), \
             mock.patch("scripts.rig.preflight_replacement", side_effect=RigError("foreign listener")), \
             mock.patch("scripts.rig.stop_owned") as stop:
            with self.assertRaisesRegex(RigError, "foreign listener"):
                self.rig.cutover("/research", "192.168.0.104", "1.1.1.1", apply=True)
        stop.assert_not_called()
        self.assertFalse(self.rig.handoff_file.exists())

    def recovery_fixture(self, restored=None):
        pid_path = self.root / "research.pid"
        pid_path.write_text("2345\n")
        original = {"name": "http", **self.record, "argv": ["python", "/research/portal.py", "80"], "pidFile": str(pid_path)}
        handoff = {"services": [original], "stopped": ["http"], "restored": [], "researchRoot": "/research",
                   "lanIp": "192.168.0.104", "upstream": "1.1.1.1"}
        if restored:
            handoff.update({"restored": ["http"], "restoredServices": {"http": restored}})
        self.rig.handoff_file.write_text(json.dumps(handoff))
        return pid_path

    def test_rollback_verifies_live_restored_identity_without_duplicate_launch(self):
        restored = {**self.record, "pid": 3456}
        self.recovery_fixture(restored)
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=True), \
             mock.patch("scripts.rig.verify_owned_listeners") as ready, mock.patch.object(self.rig, "launch") as launch:
            self.rig.rollback(apply=True)
        ready.assert_called_once_with(restored, "192.168.0.104", [("TCP", 80)])
        launch.assert_not_called()

    def test_rollback_restarts_dead_restored_pid_but_refuses_reused_live_pid(self):
        stale = {**self.record, "pid": 3456}
        new = {**self.record, "pid": 4567}
        self.recovery_fixture(stale)
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=False), \
             mock.patch("scripts.rig.process_exists", return_value=True), mock.patch.object(self.rig, "launch") as launch:
            with self.assertRaisesRegex(RigError, "changed identity"):
                self.rig.rollback(apply=True)
            launch.assert_not_called()
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=False), \
             mock.patch("scripts.rig.process_exists", return_value=False), mock.patch("scripts.rig.assert_port_available"), \
             mock.patch("scripts.rig.verify_owned_listeners"), mock.patch.object(self.rig, "launch", return_value=new) as launch:
            self.rig.rollback(apply=True)
            launch.assert_called_once()
        self.assertEqual(json.loads(self.rig.handoff_file.read_text())["restoredServices"]["http"]["pid"], 4567)

    def test_rollback_journals_process_before_pidfile_failure_and_retry_reuses_it(self):
        restored = {**self.record, "pid": 3456}
        pid_path = self.recovery_fixture()
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=False), \
             mock.patch("scripts.rig.assert_port_available"), mock.patch("scripts.rig.verify_owned_listeners"), \
             mock.patch.object(self.rig, "launch", return_value=restored), mock.patch.object(Path, "write_text", side_effect=OSError("PID write failed")):
            with self.assertRaisesRegex(OSError, "PID write failed"):
                self.rig.rollback(apply=True)
        state = json.loads(self.rig.handoff_file.read_text())
        self.assertEqual(state["restoredServices"]["http"], restored)
        self.assertEqual(state["restored"], [])
        self.assertFalse(state.get("complete", False))
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=True), \
             mock.patch("scripts.rig.verify_owned_listeners"), mock.patch.object(self.rig, "launch") as launch:
            self.rig.rollback(apply=True)
            launch.assert_not_called()
        self.assertEqual(pid_path.read_text(), "3456\n")

    def test_rollback_does_not_mark_exited_service_restored(self):
        self.recovery_fixture()
        restored = {**self.record, "pid": 3456}
        with mock.patch("scripts.rig.os.geteuid", return_value=0), mock.patch("scripts.rig.owns_process", return_value=False), \
             mock.patch("scripts.rig.assert_port_available"), mock.patch.object(self.rig, "launch", return_value=restored), \
             mock.patch("scripts.rig.verify_owned_listeners", side_effect=RigError("service exited")):
            with self.assertRaisesRegex(RigError, "service exited"):
                self.rig.rollback(apply=True)
        state = json.loads(self.rig.handoff_file.read_text())
        self.assertEqual(state["restored"], [])
        self.assertFalse(state.get("complete", False))

    def test_retry_cutover_is_sequential_and_preview_is_readonly(self):
        self.recovery_fixture()
        events = []
        with mock.patch.object(self.rig, "rollback", side_effect=lambda **kwargs: events.append("rollback")), \
             mock.patch.object(self.rig, "cutover", side_effect=lambda **kwargs: events.append("cutover")):
            self.assertFalse(self.rig.retry_cutover()["apply"])
            self.assertEqual(events, [])
            self.rig.retry_cutover(apply=True)
            self.assertEqual(events, ["rollback", "cutover"])
        with mock.patch.object(self.rig, "rollback", side_effect=RigError("restore failed")), mock.patch.object(self.rig, "cutover") as cutover:
            with self.assertRaisesRegex(RigError, "restore failed"):
                self.rig.retry_cutover(apply=True)
            cutover.assert_not_called()

    def test_dry_rollback_does_not_stop_or_restart(self):
        self.rig.handoff_file.write_text(json.dumps({"services": [{"name": "http", **self.record}], "stopped": ["http"]}))
        with mock.patch.object(self.rig, "stop") as stop, mock.patch.object(self.rig, "launch") as launch:
            result = self.rig.rollback()
            self.assertFalse(result["apply"])
            stop.assert_not_called()
            launch.assert_not_called()

    def test_symlink_state_is_rejected(self):
        file = self.root / "foreign.json"
        file.write_text("{}")
        self.rig.state_file.symlink_to(file)
        with self.assertRaises(RigError):
            self.rig.status()


if __name__ == "__main__":
    unittest.main()
