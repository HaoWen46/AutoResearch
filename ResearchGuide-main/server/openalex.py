# -*- coding: utf-8 -*-
"""OpenAlex：全学科论文目录 / 搜索 / 元数据的底座（免 key；设 OPENALEX_MAILTO 进礼貌池）。

给 sources.py 用。id 形状 `openalex:W123`（不带斜杠）；作品本身挂在 arXiv 上的（landing 是 arxiv.org/abs/…
或 DOI 是 10.48550/arXiv.…）直接归一成裸 arXiv id，正文照旧走 LaTeXML。
正文：有 OA PDF 就下载抽文（≤10 MB / 80 页，走 pdf.extract_pdf），否则只有摘要（如实标，不编）。
`recent` 不按发表日倒序（噪音太大），按「近几年被引最多」取，像一份经典目录。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from limits import ReadLimitError, TTLCache, fetch

API = "https://api.openalex.org"
MAILTO = (os.environ.get("OPENALEX_MAILTO") or "").strip()
UA = "QiyanResearchGuide/1.0 (https://chengcanwu.github.io/AutoResearch/" + (f"; mailto:{MAILTO}" if MAILTO else "") + ")"
SELECT = ("id,doi,title,display_name,publication_date,language,authorships,primary_location,locations,"
          "best_oa_location,primary_topic,abstract_inverted_index,cited_by_count")
INTERVAL = 0.25  # 礼貌池 10 次/秒；我们最多 4 次/秒
TIMEOUT = 20
MAX_BYTES = 5_000_000
RETRY_NO_PDF = 7 * 24 * 3600
RETRY_TRANSIENT = 600

_LOCK = threading.Lock()
_LAST = [0.0]
_CACHE = TTLCache(3600, 256)
_ID_RE = re.compile(r"^openalex:W\d+$", re.I)
_W_RE = re.compile(r"^(?:https?://(?:api\.)?openalex\.org/(?:works/)?)?(W\d+)/?$", re.I)
_ARXIV_URL = re.compile(r"arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})(?:v\d+)?", re.I)
_ARXIV_DOI = re.compile(r"10\.48550/arxiv\.(\d{4}\.\d{4,5})", re.I)


class OpenAlexError(Exception):
    def __init__(self, msg: str, status: int = 502):
        super().__init__(msg)
        self.status = status


def is_id(raw: str) -> bool:
    return bool(_ID_RE.match((raw or "").strip()))


def clean_id(raw: str) -> str:
    """openalex:W123 / W123 / https://openalex.org/W123 / https://api.openalex.org/works/W123 → openalex:W123。"""
    s = (raw or "").strip()
    if _ID_RE.match(s):
        return "openalex:W" + s.split(":", 1)[1][1:]
    m = _W_RE.match(s)
    if m:
        return "openalex:" + m.group(1).upper()
    raise OpenAlexError("不是 OpenAlex 作品号（形如 openalex:W123）", 400)


def abstract_of(inv: Any) -> str:
    """abstract_inverted_index → 正文顺序的摘要。"""
    if not isinstance(inv, dict) or not inv:
        return ""
    pos: list[tuple[int, str]] = []
    for word, idxs in inv.items():
        for i in idxs or []:
            pos.append((int(i), str(word)))
    pos.sort()
    return re.sub(r"\s+", " ", " ".join(w for _, w in pos)).strip()


def arxiv_id_of(w: dict[str, Any]) -> str:
    locs = [w.get("primary_location") or {}] + [loc for loc in (w.get("locations") or []) if isinstance(loc, dict)]
    for loc in locs:
        for key in ("landing_page_url", "pdf_url"):
            m = _ARXIV_URL.search(str(loc.get(key) or ""))
            if m:
                return m.group(1)
    m = _ARXIV_DOI.search(str(w.get("doi") or ""))
    return m.group(1) if m else ""


def entry(w: dict[str, Any]) -> dict[str, Any]:
    """OpenAlex work → 和 arxiv._entries 同形的条目，外加 doi / venue / oa_pdf / lang / cited_by。"""
    wid = str(w.get("id") or "").rsplit("/", 1)[-1].upper()
    aid = arxiv_id_of(w)
    loc = w.get("primary_location") or {}
    venue = str(((loc.get("source") or {}) if isinstance(loc.get("source"), dict) else {}).get("display_name") or "")
    oa = w.get("best_oa_location") or {}
    doi = str(w.get("doi") or "")
    url = doi or str(loc.get("landing_page_url") or "") or f"https://openalex.org/{wid}"
    topic = w.get("primary_topic") or {}
    cats = [x for x in (((topic.get("subfield") or {}).get("display_name")), ((topic.get("field") or {}).get("display_name"))) if x]
    title = re.sub(r"\s+", " ", str(w.get("title") or w.get("display_name") or "")).strip()
    day = str(w.get("publication_date") or "")[:10]
    return {
        "id": aid or f"openalex:{wid}", "title": title,
        "summary": abstract_of(w.get("abstract_inverted_index")),
        "authors": [str((a.get("author") or {}).get("display_name") or "") for a in (w.get("authorships") or [])[:8] if isinstance(a, dict)],
        "published": day, "updated": day, "categories": cats,
        "url": f"https://arxiv.org/abs/{aid}" if aid else url,
        "source": "arxiv" if aid else "openalex",
        "doi": doi, "venue": venue, "oa_pdf": str(oa.get("pdf_url") or "") if isinstance(oa, dict) else "",
        "lang": str(w.get("language") or ""), "cited_by": int(w.get("cited_by_count") or 0),
    }


def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    q = dict(params)
    q.setdefault("select", SELECT)
    if MAILTO:
        q["mailto"] = MAILTO
    url = API + path + "?" + urllib.parse.urlencode(q, safe="|:,/")
    hit, data = _CACHE.lookup(url)
    if hit:
        return data
    with _LOCK:
        wait = INTERVAL - (time.time() - _LAST[0])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            raw = fetch(req, timeout=TIMEOUT, max_bytes=MAX_BYTES)
        except urllib.error.HTTPError as exc:
            raise OpenAlexError(f"OpenAlex 返回 HTTP {exc.code}", exc.code) from exc
        except ReadLimitError as exc:
            raise OpenAlexError(f"OpenAlex 响应{exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise OpenAlexError("连不上 OpenAlex") from exc
        _LAST[0] = time.time()
    try:
        data = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise OpenAlexError("OpenAlex 回包不是 JSON") from exc
    if not isinstance(data, dict):
        raise OpenAlexError("OpenAlex 回包不是对象")
    _CACHE.set(url, data)
    return data


def _entries(data: dict[str, Any]) -> list[dict[str, Any]]:
    return [entry(w) for w in (data.get("results") or []) if isinstance(w, dict) and (w.get("title") or w.get("display_name"))]


def _filter(f: dict[str, str]) -> str:
    return ",".join(f"{k}:{v}" for k, v in f.items())


def search(q: str, max_results: int = 20, filters: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """全文检索（中英文都行）。输入本身是作品号就直接取那一篇。"""
    raw = (q or "").strip()
    if not raw:
        return []
    try:
        return meta([clean_id(raw)])
    except OpenAlexError:
        pass
    params: dict[str, Any] = {"search": raw[:200], "per-page": max(1, min(int(max_results), 50)),
                              "filter": _filter({"is_paratext": "false", **(filters or {})})}
    return _entries(_get("/works", params))


def recent(subfields: list[str], keywords: list[str], max_results: int = 25, years: int = 3) -> list[dict[str, Any]]:
    """某学科子领域近 `years` 年被引最多的作品（有摘要、正式文章或预印本）。"""
    f: dict[str, str] = {"has_abstract": "true", "type": "article|preprint|review", "is_paratext": "false"}
    if subfields:
        f["primary_topic.subfield.id"] = "|".join(f"subfields/{str(s).rsplit('/', 1)[-1]}" for s in subfields if str(s).strip())
    if years:
        f["from_publication_date"] = f"{time.gmtime().tm_year - int(years)}-01-01"
    params: dict[str, Any] = {"filter": _filter(f), "sort": "cited_by_count:desc",
                              "per-page": max(1, min(int(max_results), 50))}
    kws = [k for k in (keywords or []) if str(k).strip()]
    if kws:
        params["search"] = " ".join(kws)[:200]
    return _entries(_get("/works", params))


def meta(ids: list[str]) -> list[dict[str, Any]]:
    wids = []
    for i in ids or []:
        try:
            wids.append(clean_id(i).split(":", 1)[1])
        except OpenAlexError:
            continue
    if not wids:
        return []
    return _entries(_get("/works", {"filter": "openalex_id:" + "|".join(wids[:50]), "per-page": 50}))


def paper(pid: str) -> dict[str, Any] | None:
    got = meta([pid])
    return got[0] if got else None


def fulltext(pid: str) -> dict[str, Any]:
    """{id, title, source: pdf|abstract, text, url, tables, retry_after}。语义同 arxiv.fulltext；不落库（sources 落）。"""
    aid = clean_id(pid)
    p = paper(aid)
    if not p:
        raise OpenAlexError(f"OpenAlex 上没有 {aid}", 404)
    base: dict[str, Any] = {"id": aid, "title": p.get("title") or aid, "source": "abstract",
                            "text": p.get("summary") or "", "url": p.get("url") or "", "tables": [], "retry_after": 0}
    reason = "no_pdf"
    if p.get("oa_pdf"):
        try:
            req = urllib.request.Request(p["oa_pdf"], headers={"User-Agent": UA, "Accept": "application/pdf,*/*"})
            blob = fetch(req, timeout=40, max_bytes=10_000_000)
            import pdf as pdf_mod
            got = pdf_mod.extract_pdf(blob)
            if len(got.get("text") or "") > 2000:
                return {**base, "source": "pdf", "text": got["text"]}
            reason = "pdf_too_short"
        except Exception:
            reason = "pdf_failed"
    base["reason"] = reason
    base["retry_after"] = time.time() + (RETRY_TRANSIENT if reason == "pdf_failed" else RETRY_NO_PDF)
    return base
