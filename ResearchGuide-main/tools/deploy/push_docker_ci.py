"""Add container files to origin/main via Contents API and start the docker workflow."""
from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path

REPO = "repos/ChengcanWu/AutoResearch"
ROOT = Path(__file__).resolve().parents[3]
FILES = [
    "ResearchGuide-main/Dockerfile",
    "ResearchGuide-main/docker-compose.yml",
    "ResearchGuide-main/.dockerignore",
    "ResearchGuide-main/docs/DEPLOY.md",
    "ResearchGuide-main/docs/CHANGELOG.md",
    "ResearchGuide-main/docs/README.md",
    ".github/workflows/docker.yml",
]


def gh(method: str, path: str, payload: dict | None = None) -> dict:
    cmd = ["gh", "api", "--method", method, path]
    if payload is not None:
        tmp = Path(__file__).resolve().parent / ".gh-payload.json"
        tmp.write_text(json.dumps(payload), encoding="utf-8")
        p = subprocess.run(cmd + ["--input", str(tmp)], capture_output=True)
        tmp.unlink(missing_ok=True)
    else:
        p = subprocess.run(cmd, capture_output=True)
    out = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    if p.returncode != 0:
        raise SystemExit((err or out)[:1500])
    return json.loads(out) if out.strip() else {}


def main() -> None:
    for rel in FILES:
        data = (ROOT / rel).read_bytes()
        body = {
            "message": f"deploy: {rel}",
            "content": base64.b64encode(data).decode(),
        }
        try:
            old = gh("GET", f"{REPO}/contents/{rel}?ref=main")
            if old.get("sha"):
                body["sha"] = old["sha"]
        except SystemExit as e:
            if "404" not in str(e) and "Not Found" not in str(e):
                raise
        res = gh("PUT", f"{REPO}/contents/{rel}", body)
        print("put", rel, (res.get("commit") or {}).get("sha", "")[:8])
    gh("POST", f"{REPO}/actions/workflows/docker.yml/dispatches", {"ref": "main"})
    print("dispatch ok")


if __name__ == "__main__":
    main()
