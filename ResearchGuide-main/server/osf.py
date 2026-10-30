# -*- coding: utf-8 -*-
"""PsyArXiv / SocArXiv（OSF 预印本）元数据。和 arXiv 分锁。"""
from __future__ import annotations

import html
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from limits import ReadLimitError, fetch

UA = "QiyanResearchGuide/1.0 (mailto:qiyan@local)"
OSF = "https://api.osf.io/v2/preprints/"
_LOCK = threading.Lock()
_LAST = [0.0]


class OsfError(Exception):
    def __init__(self, msg: str, status: int = 502):
        super().__init__(msg)
        self.status = status


def _clean(s: str, n: int = 600) -> str:
    t = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    t = re.sub(r"\s+", " ", t).strip()
    return t[:n]


def parse_preprints(payload: dict[str, Any], provider: str) -> list[dict[str, Any]]:
    out = []
    for row in payload.get("data") or []:
        if not isinstance(row, dict):
            continue
        oid = str(row.get("id") or "")
        attrs = row.get("attributes") or {}
        title = _clean(str(attrs.get("title") or ""), 300)
        if not oid or not title:
            continue
        desc = _clean(str(attrs.get("description") or ""), 600)
        published = str(attrs.get("date_published") or attrs.get("date_created") or "")[:10]
        tags = [str(t).strip() for t in (attrs.get("tags") or []) if str(t).strip()][:8]
        links = ((row.get("links") or {}).get("html")) or f"https://osf.io/{oid}/"
        names = []
        emb = ((row.get("embeds") or {}).get("contributors") or {}).get("data") or []
        for c in emb:
            name = (((c.get("embeds") or {}).get("users") or {}).get("data") or {}).get("attributes") or {}
            full = name.get("full_name") or ""
            if full:
                names.append(full)
            if len(names) >= 4:
                break
        version = ""
        vm = re.search(r"_v(\d+)$", oid)
        if vm:
            version = vm.group(1)
            oid = oid[: vm.start()]
        out.append({
            "id": f"{provider}:{oid}",
            "version": version,
            "title": title,
            "summary": desc,
            "published": published,
            "authors": names,
            "url": links,
            "tags": tags,
            "categories": [],
            "source": provider,
        })
    return out


def recent(provider: str, subjects: list[str] | None = None, max_results: int = 25,
           cached_only: bool = False) -> list[dict[str, Any]]:
    if cached_only:
        return []
    q = {
        "filter[provider]": provider,
        "sort": "-date_created",
        "page[size]": str(min(50, max(1, max_results))),
        "embed": "contributors",
    }
    if subjects:
        q["filter[subjects]"] = ",".join(subjects)
    url = OSF + "?" + urllib.parse.urlencode(q)
    with _LOCK:
        wait = 1.0 - (time.time() - _LAST[0])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.api+json"})
        try:
            raw = fetch(req, timeout=40, max_bytes=2_000_000)
        except urllib.error.HTTPError as exc:
            raise OsfError(f"OSF 返回 HTTP {exc.code}", exc.code) from exc
        except ReadLimitError as exc:
            raise OsfError(f"OSF 响应{exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise OsfError("连不上 OSF") from exc
        _LAST[0] = time.time()
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise OsfError("OSF 回包不是 JSON") from exc
    if not isinstance(data, dict):
        raise OsfError("OSF 回包形状不对")
    return parse_preprints(data, provider)[:max_results]


def is_id(raw: str) -> bool:
    return bool(re.match(r"^(psyarxiv|socarxiv):[a-z0-9]+(?:_v\d+)?$", (raw or "").strip(), re.I))


def clean_id(raw: str) -> str:
    s = (raw or "").strip()
    m = re.match(r"^(psyarxiv|socarxiv):([a-z0-9]+)(?:_v\d+)?$", s, re.I)
    if not m:
        raise OsfError("不是有效的 OSF 预印本编号", 400)
    return f"{m.group(1).lower()}:{m.group(2).lower()}"


def _api_json(url: str) -> dict[str, Any]:
    """OSF JSON:API 一次 GET（和 recent 共用限速锁，间隔 ≥1 秒）。"""
    with _LOCK:
        wait = 1.0 - (time.time() - _LAST[0])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.api+json"})
        try:
            raw = fetch(req, timeout=40, max_bytes=2_000_000)
        except urllib.error.HTTPError as exc:
            raise OsfError(f"OSF 返回 HTTP {exc.code}", exc.code) from exc
        except ReadLimitError as exc:
            raise OsfError(f"OSF 响应{exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise OsfError("连不上 OSF") from exc
        _LAST[0] = time.time()
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise OsfError("OSF 回包不是 JSON") from exc
    return data if isinstance(data, dict) else {}


def primary_file_url(data: dict[str, Any]) -> str:
    """preprint 详情里找 primary_file 的下载地址。
    老接口 `?embed=primary_file` 自 2026-10 起一律 502，所以详情不带 embed，走 relationships.primary_file
    的 related 链接再取一次文件记录（有 embeds 时仍优先用，少打一次）。找不到返回空串。"""
    emb = ((data.get("embeds") or {}).get("primary_file") or {}) if isinstance(data.get("embeds"), dict) else {}
    fdata = emb.get("data") if isinstance(emb, dict) else None
    if isinstance(fdata, dict):
        dl = ((fdata.get("links") or {}).get("download")) or ""
        if dl:
            return dl
    rel = (data.get("relationships") or {}).get("primary_file") or {}
    href = (((rel.get("links") or {}).get("related") or {}).get("href")) or ""
    if not href and isinstance(rel.get("data"), dict) and rel["data"].get("id"):
        href = f"https://api.osf.io/v2/files/{urllib.parse.quote(str(rel['data']['id']))}/"
    if not href:
        return ""
    fd = _api_json(href).get("data") or {}
    return ((fd.get("links") or {}).get("download")) or "" if isinstance(fd, dict) else ""


def fulltext(pid: str) -> dict[str, Any]:
    """下载 preprint 的 primary_file，抽 PDF 文字；没有文件就返回摘要。"""
    aid = clean_id(pid)
    oid = aid.split(":", 1)[1]
    data = _api_json(OSF + urllib.parse.quote(oid) + "/")
    node = data.get("data") or {}
    attrs = (node.get("attributes") or {}) if isinstance(node, dict) else {}
    title = _clean(str(attrs.get("title") or ""), 300)
    summary = _clean(str(attrs.get("description") or ""), 2000)
    html_url = ((node.get("links") or {}).get("html")) or f"https://osf.io/{oid}/"
    try:
        file_url = primary_file_url(node)
    except OsfError:
        file_url = ""  # 文件记录取不到：按没有 PDF 处理，摘要照给
    if file_url:
        try:
            blob = _download(file_url)
            import pdf as pdf_mod
            extracted = pdf_mod.extract_pdf(blob)
            return {
                "id": aid, "title": title or extracted.get("title") or aid,
                "source": "pdf", "text": extracted.get("text") or "",
                "url": html_url, "tables": [], "retry_after": 0,
            }
        except Exception:
            pass
    return {
        "id": aid, "title": title or aid, "source": "abstract",
        "text": summary, "url": html_url, "tables": [], "retry_after": 0,
        "reason": "no_pdf",
    }


def _download(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    return fetch(req, timeout=40, max_bytes=10_000_000)
