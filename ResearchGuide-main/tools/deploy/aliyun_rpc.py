"""Minimal Aliyun RPC caller. Reads keys from product/.env. Do not print secrets."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # product/
ENV = ROOT / ".env"
APP = ROOT / "ResearchGuide-main"


def load_env(path: Path = ENV) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def _percent(s: str) -> str:
    return urllib.parse.quote(str(s), safe="-_.~")


def rpc(action: str, params: dict, *, version: str, endpoint: str, ak: str, sk: str) -> dict:
    q = {
        "Format": "JSON",
        "Version": version,
        "AccessKeyId": ak,
        "SignatureMethod": "HMAC-SHA1",
        "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "SignatureVersion": "1.0",
        "SignatureNonce": uuid.uuid4().hex,
        "Action": action,
        **{k: v for k, v in params.items() if v is not None},
    }
    items = sorted((k, _percent(v)) for k, v in q.items())
    canonical = "&".join(f"{_percent(k)}={v}" for k, v in items)
    string_to_sign = "GET&%2F&" + _percent(canonical)
    sig = hmac.new((sk + "&").encode(), string_to_sign.encode(), hashlib.sha1).digest()
    import base64
    q["Signature"] = base64.b64encode(sig).decode()
    url = endpoint + "/?" + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {"Code": f"HTTP{e.code}", "Message": body[:800]}
