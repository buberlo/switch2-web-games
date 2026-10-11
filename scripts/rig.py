#!/usr/bin/env python3
"""Owned DNS/HTTP lifecycle; cutover and rollback preview by default.

Never edits PF, application firewall rules, system DNS, or research source/configuration.
"""

import argparse
from contextlib import contextmanager
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
CAPTIVE_HOSTS = ("ctest.p01.ctest.srv.nintendo.net", "ctest.cdn.nintendo.net", "conntest.nintendowifi.net")
PROJECT = "switch2-web-game"


class RigError(RuntimeError):
    pass


def sudo_http_identity():
    """Sudo supplies the invoking account; do not leave HTTP running as root."""
    if os.geteuid() != 0:
        return None
    values = [os.environ.get(name, "") for name in ("SUDO_UID", "SUDO_GID")]
    if any(not re.fullmatch(r"[0-9]{1,10}", value) for value in values):
        raise RigError("root start requires valid SUDO_UID/SUDO_GID; invoke sudo from your normal account")
    uid, gid = (int(value) for value in values)
    if not 0 < uid < 2**31 or not 0 < gid < 2**31:
        raise RigError("HTTP must drop to positive non-root uid/gid")
    try:
        account = pwd.getpwuid(uid)
    except KeyError as exc:
        raise RigError("SUDO_UID does not identify an existing account") from exc
    if account.pw_gid != gid or (os.environ.get("SUDO_USER") and os.environ["SUDO_USER"] != account.pw_name):
        raise RigError("sudo account and primary group do not match")
    return uid, gid


def ipv4(value):
    address = ipaddress.IPv4Address(value)
    if address.is_unspecified or address.is_multicast or address.is_loopback:
        raise RigError("use a unicast LAN/upstream IPv4 address")
    return str(address)


def dns_config(lan_ip, upstream, port=53):
    lan_ip, upstream = ipv4(lan_ip), ipv4(upstream)
    if lan_ip == upstream:
        raise RigError("upstream must not point back to this DNS listener")
    if not 1 <= int(port) <= 65535:
        raise RigError("invalid DNS port")
    lines = ["# Generated selective captive DNS. External game/CDN names use upstream.",
             "port=%d" % port, "listen-address=" + lan_ip, "bind-interfaces", "no-resolv",
             "no-hosts", "no-poll", "server=" + upstream, "local-ttl=15", "log-queries", "log-facility=-"]
    for host in CAPTIVE_HOSTS:
        lines.extend(["host-record=%s,%s,15" % (host, lan_ip), "local=/%s/" % host])
    return "\n".join(lines) + "\n"


def process_identity(pid):
    """Creation stamp plus full command protects against reused PID files."""
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        command = subprocess.run(["ps", "-p", str(pid), "-o", "command="], check=True,
                                 capture_output=True, text=True, timeout=3).stdout.strip()
        started = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], check=True,
                                 capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    if not command or not started:
        return None
    return {"pid": pid, "command": command, "started": started}


def owns_process(record):
    return bool(record and process_identity(record.get("pid")) == {key: record.get(key) for key in ("pid", "command", "started")})


def process_exists(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def stop_owned(record):
    if not process_exists(record["pid"]):
        return
    if not owns_process(record):
        raise RigError("process identity changed or cannot be verified; refusing to signal PID %s" % record.get("pid"))
    os.kill(record["pid"], signal.SIGTERM)
    for _ in range(50):
        if not owns_process(record):
            return
        time.sleep(0.1)
    raise RigError("process did not stop; no forced kill was sent")


def assert_port_available(host, port, udp=False):
    protocol = "UDP" if udp else "TCP"
    # SO_REUSEADDR can allow ambiguous UDP sharing on BSD. A successful bind
    # must never override an unrelated listener already on this exact address.
    exact = [item for item in inspect_listeners(protocol, port) if item["address"] == host]
    if exact:
        raise RigError("existing exact-address %s listener on %s:%d; refusing shared endpoint: %s" %
                       (protocol, host, port, json.dumps(exact)))
    kind = socket.SOCK_DGRAM if udp else socket.SOCK_STREAM
    with socket.socket(socket.AF_INET, kind) as handle:
        try:
            # Match HTTPServer/dnsmasq's real bind semantics. A no-reuse probe
            # incorrectly rejects BSD wildcard/specific-address coexistence
            # and recently closed TCP sockets in TIME_WAIT.
            handle.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            handle.bind((host, port))
            if not udp:
                handle.listen(1)
        except OSError as exc:
            raise RigError("%s %s:%s is unavailable: %s" % ("UDP" if udp else "TCP", host, port, exc)) from exc


def parse_listeners(output, protocol, port):
    """Parse lsof -F records, including IPv6 wildcards and mapped IPv4."""
    listeners = []
    process, descriptor = None, None

    def finish():
        if descriptor is None:
            return
        if not process or not all(key in descriptor for key in ("family", "protocol", "name")):
            raise RigError("incomplete lsof listener record; refusing uncertain handoff")
        if descriptor["family"] not in ("IPv4", "IPv6") or descriptor["protocol"] != protocol:
            raise RigError("unexpected lsof socket type/protocol")
        if protocol == "TCP" and descriptor.get("state") != "LISTEN":
            raise RigError("TCP inventory contained a non-listening socket")
        local = descriptor["name"].split("->", 1)[0]
        match = re.fullmatch(r"(.+):([0-9]+)", local)
        if not match:
            raise RigError("unrecognized lsof socket address")
        if int(match[2]) != port:
            return  # UDP query to a remote :53 with an ephemeral local port.
        address = match[1].strip("[]")
        if address != "*":
            try:
                parsed = ipaddress.ip_address(address.split("%", 1)[0])
                address = str(parsed.ipv4_mapped) if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped else str(parsed)
            except ValueError as exc:
                raise RigError("unrecognized numeric lsof address") from exc
        listeners.append({**process, **descriptor, "address": address, "port": port})

    for line in output.splitlines():
        if not line:
            continue
        field, value = line[0], line[1:]
        if field == "p":
            finish()
            if not value.isdecimal():
                raise RigError("invalid lsof process identifier")
            process, descriptor = {"pid": int(value)}, None
        elif field == "c":
            if process is None:
                raise RigError("lsof command without process")
            process["command"] = value
        elif field == "f":
            finish()
            descriptor = {"fd": value}
        elif field in ("t", "P", "n"):
            if descriptor is None:
                raise RigError("lsof socket field without descriptor")
            descriptor[{"t": "family", "P": "protocol", "n": "name"}[field]] = value
        elif field == "T" and value.startswith("ST="):
            if descriptor is None:
                raise RigError("lsof state without descriptor")
            descriptor["state"] = value[3:]
        elif field == "T" and re.fullmatch(r"Q[RS]=[0-9]+", value):
            pass  # lsof includes harmless TCP queue sizes with state fields.
        else:
            raise RigError("unrecognized lsof output; refusing uncertain handoff")
    finish()
    return listeners


def inspect_listeners(protocol, port):
    command = ["lsof", "-nP", "-i%s:%d" % (protocol, port)]
    if protocol == "TCP":
        command.append("-sTCP:LISTEN")
    command.append("-FpcftPnT")
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RigError("cannot inspect listener ownership with lsof") from exc
    if result.stderr.strip() or result.returncode not in (0, 1) or (result.returncode == 1 and result.stdout.strip()):
        raise RigError("lsof listener inventory failed: " + result.stderr.strip())
    return parse_listeners(result.stdout, protocol, port)


def preflight_replacement(lan_ip, http_port, dns_port, owned_services):
    """Inspect foreign listeners before any research service is stopped."""
    for record in owned_services:
        if not owns_process(record):
            raise RigError("research process identity changed before listener preflight")
    owned_pids = {record["pid"] for record in owned_services}
    audit = []
    for protocol, port in (("TCP", http_port), ("TCP", dns_port), ("UDP", dns_port)):
        listeners = inspect_listeners(protocol, port)
        relevant = [item for item in listeners if item["address"] in (lan_ip, "*", "0.0.0.0", "::")]
        foreign = [item for item in relevant if item["pid"] not in owned_pids]
        exact_foreign = [item for item in foreign if item["address"] == lan_ip]
        if exact_foreign:
            raise RigError("foreign %s listener owns %s:%d; leaving research services running: %s" %
                           (protocol, lan_ip, port, json.dumps(exact_foreign)))
        exact_owned = [item for item in relevant if item["pid"] in owned_pids and item["address"] == lan_ip]
        bound_owned = any(item["pid"] in owned_pids for item in relevant)
        if foreign and exact_owned:
            evidence = "verified research endpoint already coexists with wildcard listener"
        elif not bound_owned:
            assert_port_available(lan_ip, port, udp=protocol == "UDP")
            evidence = "matching bind/listen probe passed with current listeners"
        elif foreign:
            raise RigError("foreign wildcard %s listener compatibility is unproven on %s:%d; research services unchanged" % (protocol, lan_ip, port))
        else:
            evidence = "only verified research services occupy the endpoint"
        audit.append({"protocol": protocol, "port": port, "listeners": relevant, "evidence": evidence})
    return audit


def verify_owned_listeners(record, lan_ip, endpoints):
    """A live process must own its real listening sockets before success."""
    for _ in range(30):
        if not owns_process(record):
            raise RigError("service exited or changed identity before listener readiness")
        ready = True
        for protocol, port in endpoints:
            listeners = inspect_listeners(protocol, port)
            if not any(item["pid"] == record["pid"] and item["address"] in (lan_ip, "*", "0.0.0.0", "::") for item in listeners):
                ready = False
        if ready:
            return
        time.sleep(0.1)
    raise RigError("service process is alive but does not own all expected listeners")


def pf_check(required=False):
    """Read active translations, never reload or flush them."""
    if sys.platform != "darwin":
        return {"checked": False, "reason": "PF inspection only applies to macOS"}
    result = subprocess.run(["/sbin/pfctl", "-sn"], capture_output=True, text=True)
    if result.returncode:
        if required:
            raise RigError("cannot inspect active PF translations; run the explicit direct-port command with sudo")
        return {"checked": False, "reason": "PF state unavailable without privileges"}
    rules = result.stdout.strip()
    # Old rig redirects can bypass the new listeners even when bind succeeds.
    relevant = [line for line in rules.splitlines() if "rdr" in line and any(
        term in line for term in ("port = 80", "port 80", "port = 53", "port 53"))]
    if relevant and required:
        raise RigError("existing PF DNS/HTTP translations require manual review before cutover; no PF changes made: " + "; ".join(relevant))
    return {"checked": True, "conflictingRules": relevant}


def dnsmasq_binary(value=None):
    candidates = [value] if value else [shutil.which("dnsmasq"),
        "/opt/homebrew/opt/dnsmasq/sbin/dnsmasq",
        "/usr/local/opt/dnsmasq/sbin/dnsmasq"]
    for result in candidates:
        if not result:
            continue
        path = Path(result).resolve()
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise RigError("dnsmasq executable not found; install it or pass --dnsmasq")


def atomic_json(path, value):
    if path.is_symlink():
        raise RigError("refusing symlink state file")
    temp = path.with_name(path.name + ".tmp-%d" % os.getpid())
    try:
        descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(value, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class Rig:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.data = self.root / "data"
        self.state_file = self.data / "rig-state.json"
        self.handoff_file = self.data / "rig-handoff.json"

    def ensure_data(self):
        if self.data.is_symlink():
            raise RigError("data directory must not be a symlink")
        self.data.mkdir(exist_ok=True, mode=0o700)

    def read_json(self, path):
        if path.is_symlink():
            raise RigError("refusing symlink state file")
        try:
            return json.loads(path.read_text())
        except FileNotFoundError:
            return None

    @contextmanager
    def locked(self):
        self.ensure_data()
        path = self.data / "rig.lock"
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "w") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RigError("another rig operation is in progress") from exc
            yield

    def status(self):
        state = self.read_json(self.state_file)
        if not state:
            return {"project": PROJECT, "state": "stopped", "services": {}}
        services = {name: {**record, "identityMatches": owns_process(record)}
                    for name, record in state.get("services", {}).items()}
        return {"project": PROJECT, "state": "running" if services and all(r["identityMatches"] for r in services.values()) else "needs-review",
                "services": services, "lanIp": state.get("lanIp"), "httpPort": state.get("httpPort"), "dnsPort": state.get("dnsPort")}

    def write_dns_config(self, lan_ip, upstream, port):
        self.ensure_data()
        path = self.data / "dnsmasq.conf"
        if path.is_symlink():
            raise RigError("refusing symlink dnsmasq configuration")
        path.write_text(dns_config(lan_ip, upstream, port))
        return path

    def validate_dns(self, binary, path):
        result = subprocess.run([binary, "--test", "--conf-file=" + str(path)], capture_output=True, text=True)
        if result.returncode:
            raise RigError("dnsmasq configuration rejected: " + result.stderr.strip())
        return (result.stdout + result.stderr).strip()

    def launch(self, command, log_name, log_owner=None):
        path = self.data / log_name
        descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "ab") as handle:
            if log_owner:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid not in (0, log_owner[0]):
                    raise RigError("service log must be an ordinary file owned by root or the invoking account")
                os.fchown(handle.fileno(), *log_owner)
                os.fchmod(handle.fileno(), 0o600)
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT,
                                       cwd=self.root, start_new_session=True)
        for _ in range(30):
            if process.poll() is not None:
                raise RigError("service exited; inspect " + str(path))
            record = process_identity(process.pid)
            if record:
                # Allow exec to settle before recording the command identity.
                time.sleep(0.05)
                settled = process_identity(process.pid)
                if settled:
                    return {**settled, "argv": command, "log": str(path)}
            time.sleep(0.05)
        process.terminate()
        raise RigError("could not capture service identity")

    def start(self, lan_ip, upstream, http_port=80, dns_port=53, binary=None):
        self.ensure_data()
        if self.read_json(self.state_file):
            raise RigError("rig state already exists; inspect status and stop owned services first")
        lan_ip, upstream = ipv4(lan_ip), ipv4(upstream)
        if not 1 <= int(http_port) <= 65535:
            raise RigError("invalid HTTP port")
        if min(http_port, dns_port) < 1024 and os.geteuid() != 0:
            raise RigError("direct DNS/HTTP ports require sudo; no services changed")
        http_identity = sudo_http_identity()
        pf_check(required=min(http_port, dns_port) < 1024)
        for port, udp in ((http_port, False), (dns_port, False), (dns_port, True)):
            assert_port_available(lan_ip, port, udp)
        binary = dnsmasq_binary(binary)
        config = self.write_dns_config(lan_ip, upstream, dns_port)
        self.validate_dns(binary, config)
        state = {"project": PROJECT, "lanIp": lan_ip, "upstream": upstream, "httpPort": http_port,
                 "dnsPort": dns_port, "services": {}}
        try:
            http = [sys.executable, str(self.root / "server/portal.py"), "--host", lan_ip,
                    "--port", str(http_port), "--lan-ip", lan_ip]
            if http_identity:
                http += ["--drop-uid", str(http_identity[0]), "--drop-gid", str(http_identity[1])]
            state["services"]["http"] = self.launch(http, "http-service.log", log_owner=http_identity)
            atomic_json(self.state_file, state)
            dns = [binary, "--keep-in-foreground", "--conf-file=" + str(config), "--pid-file=" + str(self.data / "dnsmasq.pid")]
            state["services"]["dns"] = self.launch(dns, "dns-service.log", log_owner=http_identity)
            atomic_json(self.state_file, state)
            for _ in range(30):
                try:
                    # Avoid inherited HTTP proxies for the local ownership check.
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                    with opener.open("http://%s:%d/healthz" % (lan_ip, http_port), timeout=1) as response:
                        health = json.load(response)
                    if health.get("project") == PROJECT and health.get("pid") == state["services"]["http"]["pid"]:
                        verify_owned_listeners(state["services"]["http"], lan_ip, [("TCP", http_port)])
                        verify_owned_listeners(state["services"]["dns"], lan_ip, [("TCP", dns_port), ("UDP", dns_port)])
                        state["instance"] = health["instance"]
                        atomic_json(self.state_file, state)
                        return self.status()
                except (OSError, ValueError):
                    pass
                time.sleep(0.1)
            raise RigError("HTTP health identity check failed")
        except Exception:
            for record in reversed(list(state["services"].values())):
                if owns_process(record):
                    try:
                        stop_owned(record)
                    except RigError:
                        pass
            if not any(owns_process(record) for record in state["services"].values()):
                self.state_file.unlink(missing_ok=True)
            raise

    def stop(self):
        state = self.read_json(self.state_file)
        if not state:
            return {"state": "stopped", "message": "no owned services recorded"}
        records = state.get("services", {})
        for record in records.values():
            if process_exists(record["pid"]) and not owns_process(record):
                raise RigError("a recorded service identity changed; refusing automatic cleanup")
        for name in ("dns", "http"):
            if name in records:
                stop_owned(records[name])
                del records[name]
                atomic_json(self.state_file, state)
        self.state_file.unlink(missing_ok=True)
        return {"state": "stopped", "message": "owned services stopped; console DNS should be Automatic when finished"}

    def research_plan(self, research):
        research = Path(research).resolve()
        records = []
        for name, pid_name, script in (("http", "portal80.pid", "server/portal.py"),
                                       ("dns", "dnsmasq53.pid", "server/dnsmasq-rig53.conf")):
            pid_path = research / "data" / pid_name
            if pid_path.is_symlink():
                raise RigError("research PID file is a symlink")
            try:
                pid = int(pid_path.read_text().strip())
            except (ValueError, FileNotFoundError) as exc:
                raise RigError("missing or invalid research PID file: " + str(pid_path)) from exc
            identity = process_identity(pid)
            if not identity or str(research / script) not in identity["command"]:
                raise RigError("research %s process identity does not match its expected project path" % name)
            argv = shlex.split(identity["command"])
            # ps prints paths without shell quoting on macOS. The research path
            # currently has no spaces, but do not guess if it changes.
            if str(research / script) not in identity["command"] or " " in str(research):
                raise RigError("cannot safely reconstruct research service command")
            if name == "http" and argv[-1] != "80":
                raise RigError("research HTTP command is not the direct port-80 service")
            if name == "dns" and not any(a.endswith(str(research / script)) for a in argv):
                raise RigError("research DNS config argument cannot be verified")
            records.append({"name": name, **identity, "argv": argv, "pidFile": str(pid_path)})
        return {"project": PROJECT, "researchRoot": str(research), "services": records,
                "preserve": ["research files", "research :8080 service", "research :443 service", "PF rules", "system DNS", "firewall rules"]}

    def cutover(self, research, lan_ip, upstream, http_port=80, dns_port=53, binary=None, apply=False):
        plan = self.research_plan(research)
        dns_config(lan_ip, upstream, dns_port)
        plan.update({"action": "cutover", "apply": apply, "lanIp": lan_ip, "upstream": upstream,
                     "httpPort": http_port, "dnsPort": dns_port})
        if not apply:
            return plan
        if os.geteuid() != 0:
            raise RigError("cutover --apply requires sudo")
        sudo_http_identity()  # Fail before stopping research services on bad sudo identity.
        previous_handoff = self.read_json(self.handoff_file)
        if self.read_json(self.state_file) or (previous_handoff and not previous_handoff.get("complete")):
            raise RigError("existing state or incomplete handoff must be resolved before a new cutover")
        pf_check(required=True)
        plan["listenerAudit"] = preflight_replacement(lan_ip, http_port, dns_port, plan["services"])
        binary = dnsmasq_binary(binary)
        self.validate_dns(binary, self.write_dns_config(lan_ip, upstream, dns_port))
        if previous_handoff:
            atomic_json(self.data / ("rig-handoff-%d.json" % time.time_ns()), previous_handoff)
        handoff = {**plan, "stopped": [], "restored": []}
        atomic_json(self.handoff_file, handoff)
        try:
            for record in plan["services"]:
                stop_owned(record)
                handoff["stopped"].append(record["name"])
                atomic_json(self.handoff_file, handoff)
            return self.start(lan_ip, upstream, http_port, dns_port, binary)
        except Exception as exc:
            # Restore only verified commands this operation stopped. Existing
            # services and PF are never modified by this rollback path.
            try:
                self.rollback(apply=True)
            except Exception as restore_error:
                raise RigError("cutover failed (%s); rollback needs attention (%s); handoff saved at %s" % (exc, restore_error, self.handoff_file)) from exc
            raise RigError("cutover failed; previous direct services restored: " + str(exc)) from exc

    def rollback(self, apply=False):
        handoff = self.read_json(self.handoff_file)
        if not handoff:
            raise RigError("no saved handoff to restore")
        plan = {"action": "rollback", "apply": apply, "services": [r for r in handoff["services"] if r["name"] in handoff["stopped"]]}
        if not apply:
            return plan
        if os.geteuid() != 0:
            raise RigError("rollback --apply requires sudo")
        if self.read_json(self.state_file):
            self.stop()
        for record in plan["services"]:
            name = record["name"]
            restored = handoff.get("restoredServices", {}).get(name)
            if name in handoff.get("restored", []) and not restored:
                raise RigError("restored service has no verifiable identity; refusing duplicate restore")
            if restored and not owns_process(restored):
                if process_exists(restored["pid"]):
                    raise RigError("restored service PID changed identity; refusing to signal or duplicate it")
                handoff["restoredServices"].pop(name)
                if name in handoff.get("restored", []):
                    handoff["restored"].remove(name)
                handoff.pop("complete", None)
                atomic_json(self.handoff_file, handoff)
                restored = None
            if not restored and owns_process(record):
                raise RigError("original PID is unexpectedly still running; refusing duplicate restore")
            # Do not start a restored daemon onto an unrelated listener. The
            # process command is not sufficient evidence that its bind worked.
            endpoints = [("TCP", 80)] if name == "http" else [("TCP", 53), ("UDP", 53)]
            if not restored:
                for protocol, port in endpoints:
                    assert_port_available(handoff["lanIp"], port, udp=protocol == "UDP")
                restored = self.launch(record["argv"], "restored-research-%s.log" % name)
                handoff.setdefault("restoredServices", {})[name] = restored
                try:
                    # Journal before touching the research PID file. If that
                    # write fails, retry can find and verify this exact process.
                    atomic_json(self.handoff_file, handoff)
                except Exception:
                    if owns_process(restored):
                        stop_owned(restored)
                    raise
            verify_owned_listeners(restored, handoff["lanIp"], endpoints)
            pid_path = Path(record["pidFile"])
            if pid_path.is_symlink():
                raise RigError("research PID file became a symlink")
            # Updating the original PID record keeps its existing stop script
            # usable; the research source/configuration stays untouched.
            pid_path.write_text(str(restored["pid"]) + "\n")
            if name not in handoff.setdefault("restored", []):
                handoff["restored"].append(name)
            atomic_json(self.handoff_file, handoff)
        handoff["complete"] = True
        atomic_json(self.handoff_file, handoff)
        return {"state": "research-restored", "handoff": str(self.handoff_file)}

    def retry_cutover(self, binary=None, apply=False):
        handoff = self.read_json(self.handoff_file)
        if not handoff:
            raise RigError("no saved handoff to retry")
        parameters = {"research": handoff["researchRoot"], "lan_ip": handoff["lanIp"],
                      "upstream": handoff["upstream"], "http_port": handoff.get("httpPort", 80),
                      "dns_port": handoff.get("dnsPort", 53), "binary": binary}
        if not apply:
            return {"action": "retry-cutover", "apply": False, "parameters": parameters,
                    "steps": ["complete and verify saved rollback", "preflight and perform fresh cutover"]}
        self.rollback(apply=True)
        return self.cutover(**parameters, apply=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("status", "doctor", "config", "start", "stop", "cutover", "rollback", "retry-cutover"))
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--lan-ip")
    parser.add_argument("--upstream", default="1.1.1.1")
    parser.add_argument("--http-port", type=int, default=80)
    parser.add_argument("--dns-port", type=int, default=53)
    parser.add_argument("--dnsmasq")
    parser.add_argument("--research-root", type=Path, help="existing research project to inspect for cutover")
    parser.add_argument("--apply", action="store_true", help="perform cutover/rollback; otherwise only print the plan")
    args = parser.parse_args()
    rig = Rig(args.root)
    try:
        if args.command == "cutover" and args.research_root is None:
            raise RigError("--research-root is required for cutover; use start for a fresh setup")
        if args.command in ("start", "config", "cutover") and not args.lan_ip:
            raise RigError("--lan-ip is required (the Mac's current LAN IPv4 address)")
        if args.command == "status":
            result = rig.status()
        elif args.command == "doctor":
            result = {"rig": rig.status(), "pf": pf_check(), "dnsmasq": dnsmasq_binary(args.dnsmasq)}
        elif args.command == "config":
            print(dns_config(args.lan_ip, args.upstream, args.dns_port), end="")
            return
        elif args.command in ("cutover", "rollback", "retry-cutover") and not args.apply:
            if args.command == "cutover":
                result = rig.cutover(args.research_root, args.lan_ip, args.upstream, args.http_port, args.dns_port, args.dnsmasq)
            elif args.command == "retry-cutover":
                result = rig.retry_cutover(args.dnsmasq)
            else:
                result = rig.rollback()
        else:
            with rig.locked():
                if args.command == "start":
                    result = rig.start(args.lan_ip, args.upstream, args.http_port, args.dns_port, args.dnsmasq)
                elif args.command == "stop":
                    result = rig.stop()
                elif args.command == "cutover":
                    result = rig.cutover(args.research_root, args.lan_ip, args.upstream, args.http_port, args.dns_port, args.dnsmasq, apply=True)
                elif args.command == "retry-cutover":
                    result = rig.retry_cutover(args.dnsmasq, apply=True)
                else:
                    result = rig.rollback(apply=True)
        print(json.dumps(result, indent=2))
    except (RigError, OSError, ValueError) as exc:
        print("rig: " + str(exc), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
