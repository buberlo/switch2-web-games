"""Identity must distinguish frontend-only edits and reject partial builds."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("runtime_build", ROOT / "scripts/build_runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class RuntimeManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for relative in runtime.FRONTEND_PATHS:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("fixture: " + relative + "\n")
        engine = self.root / "web/engine/DiabloSpawn.js"
        engine.parent.mkdir(parents=True)
        engine.write_bytes(b"function DiabloSpawn() {}\n")
        self.metadata = self.root / "web/engine/build.json"
        self.metadata.write_text(json.dumps({"sha256": runtime.digest(engine.read_bytes()), "bytes": engine.stat().st_size}))

    def command(self, *arguments):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return runtime.main(["--root", str(self.root), *arguments])

    def test_deterministic_relative_paths_and_frontend_only_change(self):
        first = runtime.build_manifest(self.root)
        self.assertEqual(first, runtime.build_manifest(self.root))
        self.assertEqual([source["path"] for source in first["sources"]], list(runtime.FRONTEND_PATHS))
        self.assertNotIn(str(self.root), json.dumps(first))
        self.assertEqual(self.command(), 0)
        self.assertEqual(self.command("--check"), 0)
        destination = self.root / runtime.MANIFEST_PATH
        previous_bytes = destination.read_bytes()
        source = self.root / "web/js/diablo-renderer.js"
        source.write_bytes(source.read_bytes() + b"// changed renderer\n")
        changed = runtime.build_manifest(self.root)
        self.assertEqual(first["engineSha256"], changed["engineSha256"])
        self.assertNotEqual(first["frontendSha256"], changed["frontendSha256"])
        self.assertNotEqual(first["revisionSha256"], changed["revisionSha256"])
        self.assertEqual(self.command("--check"), 1)
        self.assertEqual(destination.read_bytes(), previous_bytes, "--check must never replace a stale manifest")
        self.assertEqual(self.command(), 0)
        self.assertEqual(self.command("--check"), 0)
        self.assertEqual(json.loads(destination.read_text()), changed)
        self.assertEqual(list(destination.parent.glob("runtime-*.tmp")), [])

    def test_partial_engine_build_keeps_previous_identity(self):
        self.assertEqual(self.command(), 0)
        destination = self.root / runtime.MANIFEST_PATH
        previous_bytes = destination.read_bytes()
        (self.root / "web/engine/DiabloSpawn.js").write_bytes(b"unpublished engine\n")
        with self.assertRaisesRegex(RuntimeError, "Engine bytes"):
            runtime.build_manifest(self.root)
        self.assertEqual(self.command(), 1)
        self.assertEqual(destination.read_bytes(), previous_bytes)

    def test_inconsistent_engine_size_is_rejected(self):
        metadata = json.loads(self.metadata.read_text())
        metadata["bytes"] += 1
        self.metadata.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(RuntimeError, "Engine size"):
            runtime.build_manifest(self.root)


if __name__ == "__main__":
    unittest.main()
