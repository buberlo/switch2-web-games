#!/usr/bin/env python3
"""Verify and inventory the official Switch 2 23.0.0+ WebGL source reference.

Reads the ZIP without extracting or executing its contents. This audits the
distributed source, not the installed applet binary or its final build inputs.
"""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


ARCHIVE_URL = "https://support.nintendo.com/jp/oss/data/NS2_23.0.0.zip"
ARCHIVE_BYTES = 197123071
ARCHIVE_SHA256 = "a2bcdfb7ec695d1ac5c790317a1239ccdb40e0ba8e052891c2ebba1314200f90"
PREFIX = "NS2_23.0.0/"
FILES = {
    "WKC_3.12.11/WebKit/WKC/webkit/WKCVersion.h": [33, 35],
    "WKC_3.12.11/include/wkc/wkcconfig.h": [23, 147],
    "WKC_3.12.11/WTF/wtf/WKC/FeatureDefinesWKC.h": [156, 160, 161],
    "webkit_3.12.11/WTF/wtf/PlatformEnable.h": [103, 104],
    "webkit_3.12.11/WebCore/html/HTMLCanvasElement.cpp": [324, 347, 419, 425, 454],
    "webkit_3.12.11/WebCore/html/canvas/WebGLRenderingContext.idl": [38],
    "webkit_3.12.11/WebCore/html/canvas/WebGLRenderingContextBase.cpp": [819, 878],
    "WKC_3.12.11/WebKit/WKC/webkit/WKCWebView.cpp": [637, 638, 641, 644, 3646, 3647],
    "WKC_3.12.11/WebKit/WKC/helpers/privates/WKCSettings.cpp": [703, 705],
    "WKC_3.12.11/WebKit/WKC/WebCoreSupport/FrameLoaderClientWKC.cpp": [1316, 1318, 1320],
    "WKC_3.12.11/WebKit/WKC/webkit/WKCPrefs.cpp": [576, 578, 579],
    "WKC_3.12.11/include/wkc/wkcglpeer.h": [93, 102, 158],
    "WKC_3.12.11/WebCore/platform/graphics/WKC/GraphicsContext3DWKC.cpp": [31, 266],
}


def audit(path):
    if path.stat().st_size != ARCHIVE_BYTES:
        raise ValueError("Archive length differs from the recorded official download")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != ARCHIVE_SHA256:
        raise ValueError("Archive SHA-256 differs; do not treat this as the measured source")
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad:
            raise ValueError("Archive CRC failure: " + bad)
        files = []
        for relative, references in FILES.items():
            raw = archive.read(PREFIX + relative)
            lines = raw.decode("utf-8").splitlines()
            files.append({"path": PREFIX + relative, "bytes": len(raw),
                          "sha256": hashlib.sha256(raw).hexdigest(),
                          "references": [{"line": line, "text": lines[line - 1]}
                                         for line in references]})
        return {"schemaVersion": 1, "catalogUrl": "https://support.nintendo.com/jp/oss/index.html",
                "archiveUrl": ARCHIVE_URL, "archiveBytes": ARCHIVE_BYTES,
                "archiveSha256": ARCHIVE_SHA256, "zipCrcCheck": "passed",
                "entryCount": len(archive.infolist()),
                "expandedBytes": sum(info.file_size for info in archive.infolist()),
                "scope": "Official firmware-range source; final shipped binary and build inputs unverified",
                "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    args = parser.parse_args()
    try:
        result = audit(args.archive)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, "source audit: " + str(error) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
