"""The public probe must contain only reviewed code and no local state."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("probe_bundle", ROOT / "scripts/build_webgl_probe.py")
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)


class WebGLBundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for relative in bundle.SOURCES:
            target = self.root / "web" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture " + relative)
        for relative in ("data/saves/spawn0.sv", "data/diagnostics.jsonl", "web/engine/DiabloSpawn.js",
                         "web/assets/private.txt", "data/assets/spawn.mpq"):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("PRIVATE DO NOT PUBLISH")

    def test_allowlist_identity_and_private_config(self):
        revision, files, local = bundle.build(self.root, "https://probe.pages.dev", "http://192.168.1.20")
        self.assertEqual(len(files), 10)
        self.assertNotIn(b"PRIVATE", b"".join(files.values()))
        self.assertNotIn(b"192.168", b"".join(files.values()))
        self.assertIn(b"192.168.1.20", local)
        self.assertIn(revision.encode(), local)
        self.assertEqual(revision, bundle.build(self.root)[0], "Origins must not change tested source identity")
        bundle.publish(self.root, files, local)
        bundle.check(self.root, files, local)
        for relative in bundle.SOURCES:
            self.assertEqual((self.root / "web" / relative).read_bytes(), files[relative])
        manifest = json.loads(files["manifest.json"])
        self.assertEqual(manifest["revision"], revision)
        self.assertNotIn(str(self.root), files["manifest.json"].decode())

    def test_new_revision_clean_directory_and_rollback(self):
        old, files, local = bundle.build(self.root)
        bundle.publish(self.root, files, local)
        (self.root / bundle.OUTPUT / "leaked.txt").write_text("PRIVATE")
        with self.assertRaisesRegex(ValueError, "unexpected"):
            bundle.check(self.root, files, local)
        (self.root / "web/js/webgl-probe.js").write_text("updated")
        new, files, local = bundle.build(self.root)
        self.assertNotEqual(new, old)
        bundle.publish(self.root, files, local)
        bundle.check(self.root, files, local)
        self.assertFalse((self.root / bundle.OUTPUT / "leaked.txt").exists())
        self.assertTrue((self.root / "data/webgl-public.previous/leaked.txt").exists())
        self.assertNotEqual((self.root / "data/webgl-public.previous/js/webgl-probe.js").read_bytes(), files["js/webgl-probe.js"])

    def test_origin_rejection_and_symlink_source(self):
        for origin in ("http://example.com", "https://example.com/path", "https://u:p@example.com", "https://example.com#x", "https://example.com:99999", "https://127.0.0.1"):
            with self.assertRaises(ValueError, msg=origin):
                bundle.build(self.root, origin)
        for origin in ("https://192.168.1.1", "http://example.com", "http://8.8.8.8", "http://127.0.0.1/path"):
            with self.assertRaises(ValueError, msg=origin):
                bundle.build(self.root, lan_origin=origin)
        target = self.root / "web/js/webgl-probe.js"
        target.unlink()
        target.symlink_to(self.root / "data/diagnostics.jsonl")
        with self.assertRaisesRegex(ValueError, "ordinary"):
            bundle.build(self.root)

    def test_symlinked_parent_is_rejected(self):
        source = self.root / "web/js"
        outside = self.root / "outside"
        source.rename(outside)
        source.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ordinary"):
            bundle.build(self.root)

    def test_check_rejects_unlisted_directory_symlink(self):
        _, files, local = bundle.build(self.root)
        bundle.publish(self.root, files, local)
        (self.root / bundle.OUTPUT / "extra").symlink_to(self.root / "data/saves", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "ordinary"):
            bundle.check(self.root, files, local)

    def test_failed_local_config_preserves_previous_public_identity(self):
        _, old_files, old_local = bundle.build(self.root, lan_origin="http://192.168.1.20")
        bundle.publish(self.root, old_files, old_local)
        (self.root / "web/js/webgl-probe.js").write_text("new source")
        _, new_files, new_local = bundle.build(self.root)
        original = bundle.atomic_file

        def fail_config(path, body):
            if path == self.root / "web" / bundle.CONFIG:
                raise OSError("synthetic local config write failure")
            return original(path, body)

        with mock.patch.object(bundle, "atomic_file", fail_config):
            with self.assertRaisesRegex(OSError, "synthetic"):
                bundle.publish(self.root, new_files, new_local)
        bundle.check(self.root, old_files, old_local)
        self.assertEqual((self.root / "data/webgl-local-config.previous.js").read_bytes(), old_local)


if __name__ == "__main__":
    unittest.main()
