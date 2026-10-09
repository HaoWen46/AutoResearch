"""Zip ResearchGuide-main for Function Compute custom runtime."""
from __future__ import annotations

import zipfile
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "qiyan-fc.zip"
SKIP_DIR = {".git", "__pycache__", ".venv", "venv", ".pytest_cache", ".ptmp", "node_modules"}
SKIP_FILE = {".env", ".env.local", "demo.db", ".deploy.env"}
SKIP_SUF = {".pyc", ".db", ".log", ".zip"}


def main() -> None:
    if OUT.exists():
        OUT.unlink()
    n = 0
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        boot = (Path(__file__).resolve().parent / "bootstrap").read_bytes().replace(b"\r\n", b"\n")
        info = zipfile.ZipInfo("bootstrap")
        info.create_system = 3
        info.external_attr = 0o755 << 16
        z.writestr(info, boot)
        wheels = Path(__file__).resolve().parent / "vendor_wheels"
        if not wheels.exists() or not any(wheels.glob("*.whl")):
            raise SystemExit("missing vendor_wheels; run download_wheels.py")
        for w in sorted(wheels.glob("*.whl")):
            z.write(w, f"vendor_wheels/{w.name}")
            n += 1
        for p in APP.rglob("*"):
            if not p.is_file():
                continue
            rel = p.relative_to(APP)
            if any(part in SKIP_DIR for part in rel.parts):
                continue
            if p.name in SKIP_FILE or p.suffix in SKIP_SUF:
                continue
            if rel.parts[:2] == ("tools", "deploy"):
                continue
            z.write(p, rel.as_posix())
            n += 1
    print("files", n, "bytes", OUT.stat().st_size, "out", OUT)


if __name__ == "__main__":
    main()
