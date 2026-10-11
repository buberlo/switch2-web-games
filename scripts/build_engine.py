#!/usr/bin/env python3
"""Build the pinned Diablo shareware engine as JavaScript, without WebAssembly.

All source/compiler downloads and build products stay inside this repository.
No CI, remote runner, GitHub Actions, or global compiler install is used.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENGINE_REV = "798b5122731ae4b5e0c91348e5c44cf79354a94e"
EMSDK_VERSION = "3.1.74"
ENGINE_URL = "https://codeload.github.com/d07RiV/devilution/tar.gz/" + ENGINE_REV
ENGINE_SHA256 = "472c2e87718c6b710a547809c7b00871a8028d61e09db61098d16c85837644b3"
EMSDK_URL = "https://codeload.github.com/emscripten-core/emsdk/tar.gz/refs/tags/" + EMSDK_VERSION
EMSDK_SHA256 = "4f4ba50bd09e2fa5eebbfa12d0626cb7f875174ffda88b6484a1277769a07189"
SOURCE = ROOT / "vendor/devilution"
SDK = ROOT / ".toolchain/emsdk"
OBJECTS = ROOT / ".toolchain/build/diablo-spawn-js"
OUTPUT = ROOT / "web/engine/DiabloSpawn.js"
PATCHES = [ROOT / "third_party/patches/0001-optional-skip-startup-video.patch",
           ROOT / "third_party/patches/0002-native-typed-array-blits.patch",
           ROOT / "third_party/patches/0003-indexed-output-and-ui-span-cache.patch",
           ROOT / "third_party/patches/0004-silent-host-loading-and-exit-phases.patch",
           ROOT / "third_party/patches/0005-native-town-terrain.patch",
           ROOT / "third_party/patches/0006-load-game-phase-lifecycle.patch"]


def fetch_source(url, digest, destination, marker):
    stamp = destination / ".switch-build-source"
    if stamp.is_file() and stamp.read_text().strip() == marker:
        return
    # A developer may have unpacked the exact archive before invoking this script.
    # Re-extract the verified archive rather than trusting an unmarked source tree.
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError("Archive checksum mismatch: " + url)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts[1:]
            if not parts:
                continue
            if member.issym() or member.islnk() or ".." in parts:
                raise RuntimeError("Unsafe archive member: " + member.name)
            member.name = str(Path(*parts))
            archive.extract(member, destination)
    stamp.write_text(marker + "\n")


def run(args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def apply_patches():
    """Apply tracked patches to the pinned tree, accepting an exact prior apply."""
    records = [{"path": patch.relative_to(ROOT).as_posix(),
                "sha256": hashlib.sha256(patch.read_bytes()).hexdigest()} for patch in PATCHES]
    state_path = SOURCE / ".switch-build-patches.json"
    already_applied = 0
    if state_path.is_file():
        state = json.loads(state_path.read_text())
        previous = state["patches"]
        if records[:len(previous)] != previous:
            raise RuntimeError("Applied patch definitions changed; remove generated vendor/devilution and rebuild")
        for relative, digest in state["files"].items():
            if hashlib.sha256((SOURCE / relative).read_bytes()).hexdigest() != digest:
                raise RuntimeError("Patched source was modified outside the recorded build: " + relative)
        already_applied = len(previous)
    for patch in PATCHES[already_applied:]:
        command = ["patch", "--batch", "-p1", "-i", str(patch)]
        pending = subprocess.run(command + ["--forward", "--dry-run"], cwd=SOURCE,
                                 text=True, capture_output=True)
        if pending.returncode == 0:
            run(command + ["--forward"], cwd=SOURCE)
        else:
            applied = subprocess.run(command + ["--reverse", "--dry-run"], cwd=SOURCE,
                                     text=True, capture_output=True)
            if applied.returncode:
                raise RuntimeError("Patch does not match pinned source: " + str(patch)
                                   + "\n" + pending.stdout + pending.stderr)
    # Later patches can legitimately edit earlier patch contexts. Record the
    # final source hashes instead of attempting to reverse every earlier hunk.
    targets = set()
    for patch in PATCHES:
        targets.update(re.findall(r"^\+\+\+ b/([^\r\n]+)", patch.read_text(), re.MULTILINE))
    state_path.write_text(json.dumps({"patches": records, "files": {
        relative: hashlib.sha256((SOURCE / relative).read_bytes()).hexdigest()
        for relative in sorted(targets)}}, indent=2) + "\n")
    return records


def prepare():
    fetch_source(ENGINE_URL, ENGINE_SHA256, SOURCE, ENGINE_REV)
    fetch_source(EMSDK_URL, EMSDK_SHA256, SDK, EMSDK_VERSION)
    config = SDK / ".emscripten"
    compiler = SDK / "upstream/emscripten/emcc"
    if not config.is_file() or not compiler.is_file():
        run([sys.executable, SDK / "emsdk.py", "install", EMSDK_VERSION], cwd=SDK)
        run([sys.executable, SDK / "emsdk.py", "activate", EMSDK_VERSION], cwd=SDK)
    env = os.environ.copy()
    env["EM_CONFIG"] = str(config)
    env["EM_CACHE"] = str(SDK / "upstream/emscripten/cache")
    env["EMSDK"] = str(SDK)
    env["EMCC_CORES"] = "4"
    version = subprocess.check_output([str(compiler), "--version"], env=env, text=True)
    if EMSDK_VERSION not in version.splitlines()[0]:
        raise RuntimeError("Unexpected compiler version: " + version.splitlines()[0])
    return compiler, env, version.splitlines()[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--clean", action="store_true", help="Recompile all engine objects")
    parser.add_argument("--with-intro", action="store_true",
                        help="Restore upstream startup videos/title screen instead of opening the menu")
    parser.add_argument("--legacy-blit", action="store_true",
                        help="Use the original per-pixel renderer for comparison")
    parser.add_argument("--legacy-terrain", action="store_true",
                        help="Use original town tile decoding/black fills for comparison")
    parser.add_argument("--bulk-memory", dest="bulk_memory", action="store_true", default=True,
                        help="Use native typed-array memory copies/fills (default)")
    parser.add_argument("--legacy-memory", dest="bulk_memory", action="store_false",
                        help="Use the original compiled memory loops for comparison")
    parser.add_argument("--output", type=Path, default=OUTPUT,
                        help="Engine artifact destination (also writes adjacent build metadata)")
    args = parser.parse_args()
    compiler, env, version = prepare()
    patches = apply_patches()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    OBJECTS.mkdir(parents=True, exist_ok=True)
    common = ["-O2", "-fexceptions", "-DNO_SYSTEM", "-DEMSCRIPTEN", "-DZ_SOLO", "-DSPAWN",
              "-Wno-logical-op-parentheses", "-Wno-deprecated-declarations", "-I", str(SOURCE)]
    if not args.with_intro:
        common.append("-DSWITCH_SKIP_INTRO")
    if not args.legacy_blit:
        common.append("-DSWITCH_FAST_BLIT")
    if not args.legacy_terrain:
        common.append("-DSWITCH_FAST_TERRAIN")
    if args.bulk_memory:
        common.append("-mbulk-memory")
    link_flags = ["--no-entry", "-O2", "-fexceptions", "-sWASM=0", "-sLEGACY_VM_SUPPORT=1",
                  "-sWASM_BIGINT=0", "-sMODULARIZE=1", "-sEXPORT_NAME=DiabloSpawn",
                  "-sFILESYSTEM=0", "-sENVIRONMENT=web,worker", "-sALLOW_MEMORY_GROWTH=1",
                  "-sINITIAL_MEMORY=134217728", "-sMAXIMUM_MEMORY=268435456",
                  "-sSTACK_SIZE=5242880", "-sDISABLE_EXCEPTION_CATCHING=0",
                  "-sEXCEPTION_STACK_TRACES=0", "-sNO_EXIT_RUNTIME=1", "-sASSERTIONS=0"]
    if args.bulk_memory:
        link_flags.extend(["-mbulk-memory", "--pre-js", str(ROOT / "third_party/patches/bulk-memory-compat.js")])
    sources = sorted(p for p in (SOURCE / "Source").rglob("*") if p.suffix in (".c", ".cpp", ".cc"))
    # Any header or flag change invalidates all objects, avoiding stale local builds.
    inputs = hashlib.sha256(json.dumps([common, version]).encode())
    for path in sorted(p for p in (SOURCE / "Source").rglob("*") if p.is_file()):
        inputs.update(path.relative_to(SOURCE).as_posix().encode())
        inputs.update(path.read_bytes())
    signature = inputs.hexdigest()
    stamp = OBJECTS / "input-sha256"
    force = args.clean or not stamp.is_file() or stamp.read_text().strip() != signature

    def compile_one(path):
        obj = OBJECTS / (path.relative_to(SOURCE).as_posix() + ".o")
        obj.parent.mkdir(parents=True, exist_ok=True)
        if force or not obj.is_file():
            command = [str(compiler), str(path), "-c", "-o", str(obj), *common]
            if path.suffix in (".cpp", ".cc"):
                command.append("-std=c++17")
            result = subprocess.run(command, cwd=SOURCE, env=env, text=True, capture_output=True)
            if result.returncode:
                raise RuntimeError(str(path.relative_to(SOURCE)) + "\n" + result.stdout + result.stderr)
            if result.stderr:
                (obj.parent / (obj.name + ".log")).write_text(result.stderr)
        return obj

    print("Compiling", len(sources), "source files with", version, flush=True)
    objects = []
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        futures = {pool.submit(compile_one, path): path for path in sources}
        for future in as_completed(futures):
            objects.append(future.result())
            if len(objects) % 25 == 0:
                print("Compiled", len(objects), "/", len(sources), flush=True)
    stamp.write_text(signature + "\n")
    print("Linking JavaScript-only DiabloSpawn", flush=True)
    staged_output = OBJECTS / output.name
    run([compiler, *sorted(objects), "-o", staged_output, *link_flags], cwd=SOURCE, env=env)
    # Emscripten's legacy pass precedes its MODULARIZE wrapper. That wrapper
    # still contains arrow/default-argument/optional-chain syntax in 3.1.74.
    # Transpile the complete final artifact with the compiler's pinned Babel,
    # then parse as ES5 to make compatibility a checked build property.
    node = next((SDK / "node").glob("*/bin/node"))
    transform = r"""
const fs = require('fs');
const path = require('path');
const babel = require('./node_modules/@babel/core');
const preset = require('./node_modules/@babel/preset-env');
const acorn = require('./node_modules/acorn');
const filename = process.argv[1];
const original = fs.readFileSync(filename, 'utf8');
const result = babel.transformSync(original, {
  sourceType: 'script', babelrc: false, configFile: false, comments: true,
  compact: true, presets: [[preset, {targets: {ie: '11'}, modules: false, useBuiltIns: false}]]
});
acorn.parse(result.code, {ecmaVersion: 5});
fs.writeFileSync(filename, result.code + '\n');
"""
    run([node, "-e", transform, staged_output], cwd=SDK / "upstream/emscripten", env=env)
    body = staged_output.read_bytes()
    metadata = {"engine": "DiabloSpawn", "source": "https://github.com/d07RiV/devilution",
                "sourceRevision": ENGINE_REV, "emscripten": EMSDK_VERSION,
                "patches": patches, "skipStartupVideo": not args.with_intro,
                "nativeTypedArrayBlits": not args.legacy_blit,
                "maskedArtSpanCache": not args.legacy_blit,
                "nativeTownTerrain": not args.legacy_terrain,
                "townTerrainCache": {"maximumEntries": 2048, "maximumSpanBytes": 2097152,
                                     "sourceIdentityReset": ["FreeGameMem", "LoadLvlGFX"],
                                     "scope": "unlit, unmasked town microtiles; other terrain uses original renderer"} if not args.legacy_terrain else None,
                "bulkMemoryOperations": args.bulk_memory,
                "bulkMemoryCompatibilitySha256": hashlib.sha256((ROOT / "third_party/patches/bulk-memory-compat.js").read_bytes()).hexdigest() if args.bulk_memory else None,
                "optionalIndexedOutput": "draw_indexed(x,y,w,h,indices,stride,paletteRGBX)",
                "optionalHostHooks": ["profiler(name,ms)", "phase(name,details)", "sound_enabled()"],
                "runtime": "javascript", "webAssemblyRequired": False,
                "javascriptSyntax": "ES5 (Acorn verified)",
                "renderer": "host Canvas2D or indexed WebGL", "initialHeapBytes": 134217728,
                "maximumHeapBytes": 268435456, "frameIntervalMs": 50,
                "sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body),
                "compileFlags": common, "linkFlags": link_flags,
                "sourceInputSha256": signature}
    # The running local server can continue serving the previous engine until
    # the complete new ES5 artifact has passed its syntax check.
    staged_public = output.with_suffix(".js.tmp")
    staged_public.write_bytes(body)
    staged_public.replace(output)
    metadata_path = output.with_name("build.json") if output == OUTPUT else output.with_suffix(".build.json")
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    print("Built", output, "(" + str(len(body)) + " bytes)", flush=True)


if __name__ == "__main__":
    main()
