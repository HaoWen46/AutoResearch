"""Publish the static frontend to an OSS website so the browser opens it.

fcapp.run forces Content-Disposition: attachment; the OSS website endpoint does not.
Uses OSS REST (HMAC-SHA1) so we do not depend on oss2/OpenSSL.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time
import urllib.error
import urllib.request
from email.utils import formatdate
from pathlib import Path

from aliyun_rpc import load_env
from deploy_fc import STATE, write_state

REGION = "cn-hangzhou"
WEB = Path(__file__).resolve().parents[2] / "web"
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def _sign(sk: str, method: str, content_type: str, date: str, resource: str, oss_headers: dict[str, str] | None = None) -> str:
    extra = ""
    if oss_headers:
        extra = "".join(f"{k}:{oss_headers[k]}\n" for k in sorted(oss_headers))
    canonical = f"{method}\n\n{content_type}\n{date}\n{extra}{resource}"
    return base64.b64encode(hmac.new(sk.encode(), canonical.encode(), hashlib.sha1).digest()).decode()


def oss(ak: str, sk: str, method: str, bucket: str, resource: str, *, body: bytes = b"", content_type: str = "", headers: dict[str, str] | None = None, sub: str = "") -> tuple[int, bytes]:
    date = formatdate(time.time(), usegmt=True)
    oss_headers = {}
    extra = dict(headers or {})
    for k, v in list(extra.items()):
        if k.lower().startswith("x-oss-"):
            oss_headers[k.lower()] = v
    path = f"/{bucket}{sub}" if sub.startswith("?") else f"/{bucket}/{resource}" if resource else f"/{bucket}/"
    sig = _sign(sk, method, content_type, date, path if sub.startswith("?") else (f"/{bucket}/{resource}" if resource else f"/{bucket}/"), oss_headers)
    host = f"{bucket}.oss-{REGION}.aliyuncs.com"
    url = f"https://{host}/{resource}{sub}"
    req = urllib.request.Request(url, data=body if method in {"PUT", "POST"} else None, method=method)
    req.add_header("Date", date)
    req.add_header("Authorization", f"OSS {ak}:{sig}")
    if content_type:
        req.add_header("Content-Type", content_type)
    for k, v in extra.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> None:
    env = load_env()
    ak, sk = env["AccessKey_ID"], env["AccessKey_Secret"]
    rows = {}
    if STATE.exists():
        for line in STATE.read_text(encoding="utf-8").splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                rows[k] = v
    api = rows.get("PUBLIC_URL") or "https://qiyan-caxplsowco.cn-hangzhou.fcapp.run"
    tail = rows.get("ACCOUNT_TAIL") or "web"
    name = rows.get("OSS_BUCKET") or f"qiyan-web-{tail}"
    code, body = oss(ak, sk, "PUT", name, "", content_type="application/xml", headers={"x-oss-acl": "public-read"})
    print("BUCKET", code, body[:160].decode("utf-8", "replace"))
    if code not in (200, 204, 409):
        raise SystemExit(f"create bucket failed {code}")
    website = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b"<WebsiteConfiguration><IndexDocument><Suffix>index.html</Suffix></IndexDocument>"
        b"</WebsiteConfiguration>"
    )
    code, body = oss(ak, sk, "PUT", name, "", body=website, content_type="application/xml", sub="?website")
    print("WEBSITE", code, body[:160].decode("utf-8", "replace"))
    if code not in (200, 204):
        raise SystemExit(f"website failed {code}")
    n = 0
    for p in WEB.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(WEB).as_posix()
        key = "index.html" if rel == "index.html" else f"static/{rel}"
        data = p.read_bytes()
        if rel == "index.html":
            data = data.decode("utf-8").replace(
                'window.QIYAN_API = window.QIYAN_API || "";',
                f'window.QIYAN_API = "{api}";',
            ).encode("utf-8")
        ctype = TYPES.get(p.suffix, "application/octet-stream")
        code, body = oss(ak, sk, "PUT", name, key, body=data, content_type=ctype)
        print("PUT", code, key)
        if code not in (200, 204):
            raise SystemExit(f"put {key} failed {code} {body[:200]!r}")
        n += 1
    site = f"http://{name}.oss-website-{REGION}.aliyuncs.com"
    write_state({"OSS_BUCKET": name, "SITE_URL": site})
    print("FILES", n)
    print("SITE_URL", site)


if __name__ == "__main__":
    main()
